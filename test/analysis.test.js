/* 핵심 로직 단위 테스트 — 실행: node test/analysis.test.js */
const assert = require("assert");
const A = require("../js/analysis.js");

// 톤급 코드 변환
assert.strictEqual(A.parseTonCode("2X"), 2);
assert.strictEqual(A.parseTonCode("8x"), 8);
assert.strictEqual(A.parseTonCode("100"), 10);
assert.strictEqual(A.parseTonCode("180"), 18);
assert.strictEqual(A.parseTonCode("145"), 14.5);
assert.strictEqual(A.parseTonCode("ABC"), null);
assert.strictEqual(A.tonLabel(2), "2톤급");
assert.strictEqual(A.tonLabel(null), "미분류");

// 숫자 파싱 (콤마·원 표기)
assert.strictEqual(A.toNumber("36,000,000"), 36000000);
assert.strictEqual(A.toNumber("1,200원"), 1200);
assert.strictEqual(A.toNumber(15), 15);

// 컬럼 자동 매핑
const p = A.normalizePurchase([
  { "품번": "P-1", "업체명": "A업체", "연간 구매 물량": "100", "연간 구매 금액": "1,000" }
]);
assert.deepStrictEqual(p.errors, []);
assert.strictEqual(p.rows[0].qty, 100);
assert.strictEqual(p.rows[0].amt, 1000);

const m = A.normalizeModel([
  { "품번": "P-1", "장비 모델명": "25D-9", "톤급 코드": "2X" }
]);
assert.deepStrictEqual(m.errors, []);

// 컬럼 매핑 엄격화: 정확 일치 우선, 부분 일치는 후보가 유일할 때만
assert.strictEqual(A.findColumn(["품번", "업체명", "금액"], "amt"), "금액"); // 정확 일치
assert.strictEqual(A.findColumn(["Part Number", "Vendor"], "part"), "Part Number"); // 정규화(대소문자·공백) 일치
assert.strictEqual(A.findColumn(["연간 구매 금액(원)"], "amt"), "연간 구매 금액(원)"); // 부분 일치 — 후보 유일
assert.strictEqual(A.findColumn(["구매 금액(내수)", "구매 금액(수출)"], "amt"), null); // 부분 일치 모호 → 미매핑
const amb = A.normalizePurchase([
  { "품번": "P-1", "업체명": "A업체", "연간 구매 물량": "1", "구매 금액(내수)": "10", "구매 금액(수출)": "20" }
]);
assert.ok(amb.errors.length > 0, "모호한 컬럼은 오류로 알려야 함");

// 음수 물량/금액 검증: 집계에서 제외 + 경고 메시지
const neg = A.normalizePurchase([
  { "품번": "P-1", "업체명": "A업체", "연간 구매 물량": "100", "연간 구매 금액": "1,000" },
  { "품번": "P-2", "업체명": "B업체", "연간 구매 물량": "-5", "연간 구매 금액": "500" },
  { "품번": "P-3", "업체명": "C업체", "연간 구매 물량": "10", "연간 구매 금액": "-100" }
]);
assert.deepStrictEqual(neg.errors, []);
assert.strictEqual(neg.rows.length, 1); // 음수 2행 제외
assert.strictEqual(neg.rows[0].part, "P-1");
assert.strictEqual(neg.warnings.length, 1);
assert.ok(neg.warnings[0].indexOf("2행") !== -1, "제외된 행 수가 경고에 표시되어야 함");
assert.deepStrictEqual(p.warnings, []); // 정상 데이터는 경고 없음

// 조인: 1:N 품번은 모든 모델에 연계, 모델 미매칭 품번 별도 표기
const purchase = [
  { part: "P-1", vendor: "A업체", qty: 100, amt: 1000 },
  { part: "P-1", vendor: "B업체", qty: 300, amt: 3000 },
  { part: "P-2", vendor: "A업체", qty: 50, amt: 500 },
  { part: "P-9", vendor: "C업체", qty: 10, amt: 90 }
];
const model = [
  { part: "P-1", model: "25D-9", tonCode: "2X" },
  { part: "P-1", model: "30L-7", tonCode: "3X" },
  { part: "P-2", model: "25D-9", tonCode: "2X" }
];
const joined = A.joinData(purchase, model);
assert.strictEqual(joined.records.length, 2 + 2 + 1 + 1); // P-1 두 업체 × 두 모델 + P-2 + 미매칭 P-9
assert.deepStrictEqual(joined.unmatchedParts, ["P-9"]);
// 각 레코드는 구매 원본 행 인덱스(srcIdx)를 보존 — 1:N 중복 제거 집계용
assert.deepStrictEqual(joined.records.map(r => r.srcIdx), [0, 0, 1, 1, 2, 3]);

// 트리: 톤급 숫자 정렬(2 → 3 → 미분류)
const tree = A.buildTree(joined.records);
assert.deepStrictEqual(tree.map(t => t.name), ["2톤급", "3톤급", "미분류"]);

// 2톤급 = P-1(두 업체) + P-2 집계
const t2 = tree[0];
assert.strictEqual(t2.qty, 100 + 300 + 50);
assert.strictEqual(t2.amt, 1000 + 3000 + 500);

// 업체 비중 (금액 기준): 2톤급 내 B업체 3000/4500
const shares = A.vendorShares(t2, "amt");
assert.strictEqual(shares[0].vendor, "B업체");
assert.ok(Math.abs(shares[0].share - (3000 / 4500) * 100) < 1e-9);

// 집중도: 임계 60% — 25D-9 모델(2톤급)은 B업체 3000/3500 ≈ 85.7% → 하이라이트
const hits = A.concentration(tree, 60, "amt");
const modelHit = hits.find(h => h.level === "모델" && h.name === "25D-9" && h.ton === "2톤급");
assert.ok(modelHit, "모델 집중도 하이라이트 누락");
assert.strictEqual(modelHit.topVendor, "B업체");
// 품번 P-2는 A업체 100% → 하이라이트
assert.ok(hits.some(h => h.level === "품번" && h.name === "P-2" && h.share === 100));

// KPI는 구매 원본 기준(1:N 중복 없음)
const k = A.kpis(purchase);
assert.strictEqual(k.totalQty, 460);
assert.strictEqual(k.totalAmt, 4590);
assert.strictEqual(k.partCount, 3);
assert.strictEqual(k.vendorCount, 3);

// 필터
assert.strictEqual(A.filterRecords(joined.records, { ton: 2 }).length, 3);
assert.strictEqual(A.filterRecords(joined.records, { vendor: "A업체", ton: 2 }).length, 2);

console.log("✅ analysis.test.js — 모든 테스트 통과");
