-- 로컬 검증 전용 — hd-project01 프로젝트별 검증 (운영 실행 금지)
do $guard$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_admin', 'authenticator'))
     or exists (select 1 from pg_namespace where nspname = 'graphql') then
    raise exception '이 파일은 로컬 검증 전용입니다.';
  end if;
end;
$guard$;

do $t$ begin raise notice '[프로젝트] 톤급 파싱 · 안분 · 비중'; end $t$;

do $t$ begin
  perform public._assert_eq(public.tonnage_num('3톤'),    3::numeric,   '"3톤" → 3');
  perform public._assert_eq(public.tonnage_num('3.5 TON'), 3.5::numeric, '"3.5 TON" → 3.5');
  perform public._assert_eq(public.tonnage_num('5t'),     5::numeric,   '"5t" → 5');
  perform public._assert(public.tonnage_num('미상') is null, '숫자가 없으면 null');
  perform public._assert(public.tonnage_num(null) is null,   'null 은 null');
end $t$;

do $t$
declare v_up bigint;
begin
  insert into public.upload (label, period) values ('테스트', '2026-08') returning id into v_up;

  -- P1 은 모델 두 개에 쓰인다 → 금액이 두 번 세어지면 안 된다
  insert into public.model (part_no, model, tonnage) values
    ('P1', 'M-A', '3톤'), ('P1', 'M-B', '5톤'), ('P2', 'M-A', '3톤')
  on conflict (part_no, model) do nothing;

  insert into public.purchase (upload_id, period, part_no, vendor_name, qty, amount) values
    (v_up, '2026-08', 'P1', '업체가', 10, 1000),
    (v_up, '2026-08', 'P2', '업체나', 20, 3000),
    (v_up, '2026-08', 'P9', '업체다',  5,  500)   -- 모델 마스터에 없는 품번
  on conflict (upload_id, part_no, vendor_name) do nothing;

  -- 트리거가 정렬용 숫자를 채웠는가
  perform public._assert_eq(
    (select tonnage_num from public.model where part_no = 'P1' and model = 'M-A'),
    3::numeric, '트리거가 톤급 숫자를 자동으로 채운다');

  -- 안분: P1 금액 1000 이 모델 2개로 500 씩
  perform public._assert_eq(
    (select amount_alloc from public.purchase_expanded
      where part_no = 'P1' and model = 'M-A'), 500::numeric,
    '한 품번이 두 모델에 쓰이면 금액을 나눠 담는다');

  -- 총액이 부풀지 않아야 한다 — 조인 중복으로 커지는 것이 이 검사의 요점
  perform public._assert_eq(
    (select round(sum(amount)) from public.by_tonnage where period = '2026-08'),
    4500::numeric, '톤급 합계가 원본 총액(4,500)과 같다 (조인으로 부풀지 않는다)');

  -- 모델이 없는 품번도 빠지지 않는다
  perform public._assert_eq(
    (select round(amount) from public.by_tonnage
      where period = '2026-08' and tonnage = '(미매칭)'), 500::numeric,
    '모델 마스터에 없는 품번도 (미매칭)으로 집계에 남는다');

  perform public._assert_eq(
    (select count(*) from public.unmatched_parts where part_no = 'P9'),
    1::bigint, '미매칭 품번이 별도 뷰로 드러난다');

  -- 업체별 비중 합이 100%
  perform public._assert_eq(
    (select round(sum(amount_share)) from public.by_vendor where period = '2026-08'),
    100::numeric, '업체별 비중 합계가 100%');

  -- 중복 방지는 DB 제약으로
  declare v_raised boolean := false;
  begin
    begin
      insert into public.purchase (upload_id, period, part_no, vendor_name, qty, amount)
      values (v_up, '2026-08', 'P1', '업체가', 99, 9999);
    exception when unique_violation then v_raised := true;
    end;
    perform public._assert(v_raised, '같은 회차·품번·업체 중복은 UNIQUE 가 막는다');
  end;

  -- 잘못된 기간 표기
  declare v_raised2 boolean := false;
  begin
    begin
      insert into public.upload (label, period) values ('X', '2026-13');
    exception when check_violation then v_raised2 := true;
    end;
    perform public._assert(v_raised2, '잘못된 기간 표기는 check 제약이 막는다');
  end;
end $t$;

delete from public.upload where label = '테스트';
delete from public.model where part_no in ('P1','P2');

do $t$ begin raise notice ''; raise notice '전부 통과했습니다.'; end $t$;
