-- ============================================================================
-- hd-project01 — 톤급→모델→품번→업체 구매 분석 대시보드
-- Supabase(Postgres) 운영 스키마 + RLS
--
--  실행 위치 : Supabase Dashboard → SQL Editor
--  재실행    : 안전합니다 (IF NOT EXISTS / DROP ... IF EXISTS 선행)
--
--  이 스키마는 **수강생 본인의 Supabase 프로젝트**에 올리는 것을 전제로 합니다.
--  프로젝트가 본인 것이라 테이블 이름에 접두사를 붙이지 않았습니다.
--  (여러 앱을 한 프로젝트에 몰아 쓸 계획이면 이름 충돌을 먼저 확인하세요.)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 테이블
-- ----------------------------------------------------------------------------

-- 업로드 회차 — 엑셀 한 벌을 올릴 때마다 한 행.
-- 이전 회차를 지우지 않고 쌓아 두어야 "지난달 대비"를 볼 수 있다.
create table if not exists public.upload (
  id           bigint generated always as identity primary key,
  label        text not null,                    -- '2026년 8월 구매실적'
  period       text not null                     -- 'YYYY-MM'
               check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kind         text not null default '구매'
               check (kind in ('구매', '모델마스터')),
  row_count    int not null default 0,
  uploaded_at  timestamptz not null default now(),
  uploaded_by  uuid default auth.uid(),
  note         text
);
create index if not exists upload_period_idx on public.upload (period desc);

-- 장비 모델 마스터 — 품번이 어느 모델·톤급에 쓰이는가.
-- 한 품번이 여러 모델에 쓰일 수 있어 (part_no, model) 이 키다.
create table if not exists public.model (
  id          bigint generated always as identity primary key,
  part_no     text not null,
  model       text not null,
  tonnage     text,                              -- '3톤', '5톤' … 표기가 갈려서 text
  tonnage_num numeric,                           -- 정렬용 숫자값
  updated_at  timestamptz not null default now(),
  constraint model_part_model_key unique (part_no, model)
);
create index if not exists model_part_idx    on public.model (part_no);
create index if not exists model_tonnage_idx on public.model (tonnage_num);

-- 구매 실적 — 업로드 회차 × 품번 × 업체
create table if not exists public.purchase (
  id          bigint generated always as identity primary key,
  upload_id   bigint not null references public.upload(id) on delete cascade,
  period      text not null,
  part_no     text not null,
  part_name   text,
  vendor_code text,
  vendor_name text not null,
  qty         numeric not null default 0,
  amount      numeric not null default 0,
  -- 같은 회차·같은 품번·같은 업체가 두 번 들어오면 합계가 두 배가 된다.
  -- 중복 방지는 클라이언트가 아니라 여기서 한다.
  -- ⚠ 프런트에서 upsert 할 때 onConflict 를 이 컬럼 조합으로 반드시 지정할 것.
  constraint purchase_uniq unique (upload_id, part_no, vendor_name)
);
create index if not exists purchase_period_idx on public.purchase (period);
create index if not exists purchase_part_idx   on public.purchase (part_no);
create index if not exists purchase_vendor_idx on public.purchase (vendor_name);

-- 저장된 보고서 (드릴다운 상태 + 메모)
create table if not exists public.report (
  id          bigint generated always as identity primary key,
  title       text not null,
  period      text,
  filters     jsonb not null default '{}'::jsonb,   -- {tonnage, model, partNo, vendor}
  memo        text,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

-- 실행로그 — 기록성 테이블이라 UPDATE/DELETE 정책을 두지 않는다
create table if not exists public.log (
  id         bigint generated always as identity primary key,
  ran_at     timestamptz not null default now(),
  kind       text not null,
  detail     text,
  processed  int not null default 0,
  failed     int not null default 0,
  actor      uuid default auth.uid()
);
create index if not exists log_ran_at_idx on public.log (ran_at desc);

create table if not exists public.admin (
  user_id    uuid primary key,
  email      text,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. 함수
--
--  ⚠ search_path 를 고정한다. 고정하지 않으면 호출자의 search_path 에 따라
--    엉뚱한 스키마의 객체를 잡을 수 있다.
-- ----------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from public.admin a where a.user_id = auth.uid());
$fn$;

-- '3톤', '3.5 TON', '3t' 같은 표기에서 숫자만 뽑는다. 톤급 정렬에 쓴다.
create or replace function public.tonnage_num(p_text text)
returns numeric language sql immutable set search_path = public as $fn$
  select nullif(regexp_replace(coalesce(p_text, ''), '[^0-9.]', '', 'g'), '')::numeric;
$fn$;

-- 모델 마스터 입력 시 정렬용 숫자를 자동으로 채운다
create or replace function public.fill_tonnage()
returns trigger language plpgsql set search_path = public as $fn$
begin
  if new.tonnage_num is null then
    new.tonnage_num := public.tonnage_num(new.tonnage);
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists model_fill_tonnage on public.model;
create trigger model_fill_tonnage
  before insert or update on public.model
  for each row execute function public.fill_tonnage();

-- ----------------------------------------------------------------------------
-- 3. 뷰 — 톤급 → 모델 → 품번 → 업체 드릴다운
--
--  ⚠ 한 품번이 여러 모델에 쓰이면 조인으로 금액이 여러 번 세어진다.
--    그래서 모델 수로 나눠 안분(按分)한다. 안 그러면 합계가 실제보다 커진다.
-- ----------------------------------------------------------------------------


-- ⚠ 뷰에는 `with (security_invoker = true)` 를 붙인다.
--   붙이지 않으면 뷰는 **만든 사람(postgres)의 권한**으로 돌아, 뷰를 읽을 수 있는
--   사람이 밑에 깔린 표의 RLS 를 통째로 지나친다. 표만 잠그고 뷰를 안 잠그면 헛일이다.
--   (hd-project03 에서 실제로 남의 업체 실사 결과가 뷰로 그대로 보였다.
--    tests/server.test.js 의 "업체는 보고서 뷰로도 남의 자료를 볼 수 없다" 가 잡는다)
--   security_invoker 는 PostgreSQL 15 부터. Supabase 는 15 이상이다.
create or replace view public.purchase_expanded with (security_invoker = true) as
with model_cnt as (
  select part_no, count(*)::numeric as n from public.model group by part_no
)
select
  p.id            as purchase_id,
  p.upload_id,
  p.period,
  p.part_no,
  p.part_name,
  p.vendor_code,
  p.vendor_name,
  m.model,
  m.tonnage,
  m.tonnage_num,
  p.qty,
  p.amount,
  -- 모델이 여러 개면 나눠 담는다. 매칭 모델이 없으면 그대로 1로 둔다.
  p.qty    / coalesce(c.n, 1) as qty_alloc,
  p.amount / coalesce(c.n, 1) as amount_alloc
from public.purchase p
left join public.model m on m.part_no = p.part_no
left join model_cnt c          on c.part_no = p.part_no;

create or replace view public.by_tonnage with (security_invoker = true) as
select period, coalesce(tonnage, '(미매칭)') as tonnage, min(tonnage_num) as tonnage_num,
       count(distinct part_no) as part_count,
       count(distinct vendor_name) as vendor_count,
       sum(qty_alloc) as qty, sum(amount_alloc) as amount
from public.purchase_expanded
group by period, coalesce(tonnage, '(미매칭)');

create or replace view public.by_model with (security_invoker = true) as
select period, coalesce(tonnage, '(미매칭)') as tonnage, coalesce(model, '(미매칭)') as model,
       count(distinct part_no) as part_count,
       sum(qty_alloc) as qty, sum(amount_alloc) as amount
from public.purchase_expanded
group by period, coalesce(tonnage, '(미매칭)'), coalesce(model, '(미매칭)');

create or replace view public.by_vendor with (security_invoker = true) as
select period, vendor_name,
       count(distinct part_no) as part_count,
       sum(qty_alloc) as qty, sum(amount_alloc) as amount,
       -- 업체별 비중(%) — 기획서의 핵심 지표
       round(sum(amount_alloc) * 100
             / nullif(sum(sum(amount_alloc)) over (partition by period), 0), 2) as amount_share
from public.purchase_expanded
group by period, vendor_name;

-- 모델 마스터에 없는 품번 — 대시보드가 조용히 빠뜨리는 것을 드러낸다
create or replace view public.unmatched_parts with (security_invoker = true) as
select distinct p.period, p.part_no, p.part_name, p.vendor_name, p.qty, p.amount
from public.purchase p
where not exists (select 1 from public.model m where m.part_no = p.part_no);

-- ----------------------------------------------------------------------------
-- 4. RLS — 읽기는 로그인 사용자, 쓰기는 관리자
-- ----------------------------------------------------------------------------

alter table public.upload   enable row level security;
alter table public.model    enable row level security;
alter table public.purchase enable row level security;
alter table public.report   enable row level security;
alter table public.log      enable row level security;
alter table public.admin    enable row level security;

do $rls$
declare t text;
begin
  foreach t in array array['upload','model','purchase','report']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_read',   t);
    execute format('drop policy if exists %I on public.%I', t || '_write',  t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)',
                   t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_admin())',
                   t || '_write', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())',
                   t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_admin())',
                   t || '_delete', t);
  end loop;
end;
$rls$;

drop policy if exists log_read  on public.log;
drop policy if exists log_write on public.log;
create policy log_read  on public.log for select to authenticated using (true);
create policy log_write on public.log for insert to authenticated with check (true);

drop policy if exists admin_read on public.admin;
create policy admin_read on public.admin for select to authenticated using (public.is_admin());

-- ----------------------------------------------------------------------------
-- 5. 함수 실행 권한
--
--  ⚠ GRANT 만으로는 제한되지 않는다. 권한이 두 겹으로 미리 붙는다.
--    ① Postgres 가 함수 생성 시 PUBLIC 에 EXECUTE 기본 부여
--    ② Supabase 가 ALTER DEFAULT PRIVILEGES 로 신규 함수마다
--       anon·authenticated·service_role 에 자동 부여
--    PUBLIC 만 지우면 anon=X 가 남아 비로그인 호출이 그대로 뚫린다.
-- ----------------------------------------------------------------------------

revoke all on function public.is_admin()          from public, anon;
revoke all on function public.tonnage_num(text)   from public, anon;
revoke all on function public.fill_tonnage()      from public, anon;

grant execute on function public.is_admin()        to authenticated;
grant execute on function public.tonnage_num(text) to authenticated;
-- 트리거 전용 함수는 authenticated 를 남긴다. 트리거 발화 시 호출자 EXECUTE 를
-- 검사하는지 확실치 않은데, 검사한다면 끊는 순간 관리자 입력이 막힌다.
-- 직접 호출하면 "can only be called as trigger" 로 죽으므로 무해하다.
grant execute on function public.fill_tonnage()    to authenticated;

-- ----------------------------------------------------------------------------
-- 끝. 관리자 등록:
--   insert into public.admin (user_id, email)
--   select id, email from auth.users where email = '<관리자 이메일>'
--   on conflict (user_id) do nothing;
-- ----------------------------------------------------------------------------
