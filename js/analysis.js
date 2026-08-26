/**
 * 구매 분석 핵심 로직 (UI 독립 — 브라우저/Node 공용)
 *
 * 데이터 흐름:
 *  구매 데이터(품번·업체·물량·금액) + 모델 데이터(품번·모델·톤급 코드)
 *  → 품번 기준 조인 → 톤급 변환 → 톤급>모델>품번>업체 계층 집계 → 업체 비중/집중도
 *
 * 주의: 하나의 품번이 여러 모델에 적용되면(1:N) 기획서에 따라 모든 모델에
 * 연계한다. 따라서 "모델 관점" 집계(트리)는 품번 물량·금액이 모델 수만큼
 * 중복 포함되며, 전체 KPI는 구매 데이터 원본 기준으로 별도 계산한다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Analysis = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** 톤급 코드 → 톤 수. "2X"~"9X"는 앞자리, "100"~"999"는 ÷10. 실패 시 null */
  function parseTonCode(code) {
    if (code === null || code === undefined) return null;
    var s = String(code).trim().toUpperCase();
    var m = s.match(/^(\d)X$/);
    if (m) return parseInt(m[1], 10);
    if (/^\d{3}$/.test(s)) return parseInt(s, 10) / 10;
    return null;
  }

  function tonLabel(ton) {
    return ton === null ? "미분류" : ton + "톤급";
  }

  /** 컬럼명 자동 매핑: 후보 별칭 목록에서 실제 헤더를 찾는다 */
  var COLUMN_ALIASES = {
    part: ["품번", "part number", "partnumber", "part_no", "품목번호", "자재번호"],
    vendor: ["업체명", "업체", "협력업체", "vendor", "supplier", "공급업체"],
    qty: ["연간 구매 물량", "구매 물량", "물량", "수량", "qty", "quantity", "구매수량"],
    amt: ["연간 구매 금액", "구매 금액", "금액", "amount", "구매금액"],
    model: ["장비 모델명", "모델명", "모델", "model", "장비모델"],
    tonCode: ["톤급 코드", "톤급코드", "톤급", "ton", "톤급 정보", "ton code"]
  };

  function findColumn(headers, key) {
    var aliases = COLUMN_ALIASES[key];
    var norm = function (h) { return String(h).trim().toLowerCase().replace(/\s+/g, ""); };
    // 1) 원문 그대로 일치 (앞뒤 공백만 무시)
    for (var i0 = 0; i0 < aliases.length; i0++) {
      for (var j0 = 0; j0 < headers.length; j0++) {
        if (String(headers[j0]).trim() === aliases[i0]) return headers[j0];
      }
    }
    // 2) 정규화(공백 제거·소문자) 후 일치
    for (var i = 0; i < aliases.length; i++) {
      var a = norm(aliases[i]);
      for (var j = 0; j < headers.length; j++) {
        if (norm(headers[j]) === a) return headers[j];
      }
    }
    // 3) 부분 일치 — 최후 수단. 후보 헤더가 정확히 하나일 때만 채택하고,
    //    여러 개가 걸리면 잘못 매핑될 수 있으므로 미매핑(null)으로 남긴다.
    var candidates = {};
    for (var i2 = 0; i2 < aliases.length; i2++) {
      var a2 = norm(aliases[i2]);
      for (var j2 = 0; j2 < headers.length; j2++) {
        if (norm(headers[j2]).indexOf(a2) !== -1) candidates[headers[j2]] = true;
      }
    }
    var found = Object.keys(candidates);
    return found.length === 1 ? found[0] : null;
  }

  function toNumber(v) {
    if (typeof v === "number") return v;
    if (v === null || v === undefined) return 0;
    var n = parseFloat(String(v).replace(/[,\s원]/g, ""));
    return isNaN(n) ? 0 : n;
  }

  /** 객체 배열(헤더 키) → 표준 구매 레코드 */
  function normalizePurchase(rows) {
    if (!rows.length) return { rows: [], mapping: null, errors: ["구매 데이터가 비어 있습니다."], warnings: [] };
    var headers = Object.keys(rows[0]);
    var map = {
      part: findColumn(headers, "part"),
      vendor: findColumn(headers, "vendor"),
      qty: findColumn(headers, "qty"),
      amt: findColumn(headers, "amt")
    };
    var errors = [];
    ["part", "vendor", "qty", "amt"].forEach(function (k) {
      if (!map[k]) errors.push("구매 데이터에서 '" + k + "' 컬럼을 찾지 못했습니다(유사 컬럼이 여러 개면 모호하여 매핑하지 않습니다 — 헤더명을 표준 양식에 맞춰 주세요).");
    });
    if (errors.length) return { rows: [], mapping: map, errors: errors, warnings: [] };
    var negativeCount = 0;
    var out = rows.map(function (r) {
      return {
        part: String(r[map.part]).trim(),
        vendor: String(r[map.vendor]).trim(),
        qty: toNumber(r[map.qty]),
        amt: toNumber(r[map.amt])
      };
    }).filter(function (r) { return r.part && r.vendor; })
      .filter(function (r) {
        // 음수 물량/금액은 데이터 오류로 보고 집계에서 제외
        if (r.qty < 0 || r.amt < 0) { negativeCount++; return false; }
        return true;
      });
    var warnings = [];
    if (negativeCount > 0) {
      warnings.push("구매 물량 또는 구매 금액이 음수인 " + negativeCount + "행을 데이터 오류로 판단하여 집계에서 제외했습니다. 원본 엑셀을 확인해 주세요.");
    }
    return { rows: out, mapping: map, errors: [], warnings: warnings };
  }

  /** 객체 배열 → 표준 모델 레코드 */
  function normalizeModel(rows) {
    if (!rows.length) return { rows: [], mapping: null, errors: ["모델 데이터가 비어 있습니다."], warnings: [] };
    var headers = Object.keys(rows[0]);
    var map = {
      part: findColumn(headers, "part"),
      model: findColumn(headers, "model"),
      tonCode: findColumn(headers, "tonCode")
    };
    var errors = [];
    ["part", "model", "tonCode"].forEach(function (k) {
      if (!map[k]) errors.push("모델 데이터에서 '" + k + "' 컬럼을 찾지 못했습니다(유사 컬럼이 여러 개면 모호하여 매핑하지 않습니다 — 헤더명을 표준 양식에 맞춰 주세요).");
    });
    if (errors.length) return { rows: [], mapping: map, errors: errors, warnings: [] };
    var out = rows.map(function (r) {
      return {
        part: String(r[map.part]).trim(),
        model: String(r[map.model]).trim(),
        tonCode: String(r[map.tonCode]).trim().toUpperCase()
      };
    }).filter(function (r) { return r.part && r.model; });
    return { rows: out, mapping: map, errors: [], warnings: [] };
  }

  /**
   * 품번 기준 조인. 1:N(품번→모델)은 모든 모델에 연계.
   * 각 레코드는 구매 원본 행 인덱스(srcIdx)를 보존한다 — 1:N 중복 제거 집계용.
   * 반환: { records, unmatchedParts(모델 정보 없는 품번 목록) }
   */
  function joinData(purchaseRows, modelRows) {
    var byPart = {};
    modelRows.forEach(function (m) {
      (byPart[m.part] = byPart[m.part] || []).push(m);
    });
    var records = [];
    var unmatched = {};
    purchaseRows.forEach(function (p, srcIdx) {
      var models = byPart[p.part];
      if (!models || !models.length) {
        unmatched[p.part] = true;
        var t0 = null;
        records.push({
          srcIdx: srcIdx, part: p.part, vendor: p.vendor, qty: p.qty, amt: p.amt,
          model: "(모델 미매칭)", tonCode: "-", ton: t0, tonLabel: tonLabel(t0)
        });
        return;
      }
      models.forEach(function (m) {
        var t = parseTonCode(m.tonCode);
        records.push({
          srcIdx: srcIdx, part: p.part, vendor: p.vendor, qty: p.qty, amt: p.amt,
          model: m.model, tonCode: m.tonCode, ton: t, tonLabel: tonLabel(t)
        });
      });
    });
    return { records: records, unmatchedParts: Object.keys(unmatched) };
  }

  function filterRecords(records, f) {
    f = f || {};
    return records.filter(function (r) {
      if (f.ton !== undefined && f.ton !== null && f.ton !== "" && String(r.ton) !== String(f.ton)) return false;
      if (f.model && r.model !== f.model) return false;
      if (f.vendor && r.vendor !== f.vendor) return false;
      return true;
    });
  }

  function sumInto(node, r) {
    node.qty += r.qty;
    node.amt += r.amt;
    var v = node.vendorMap[r.vendor] = node.vendorMap[r.vendor] || { vendor: r.vendor, qty: 0, amt: 0 };
    v.qty += r.qty;
    v.amt += r.amt;
  }

  function newNode(name, extra) {
    var n = { name: name, qty: 0, amt: 0, vendorMap: {}, children: {} };
    if (extra) Object.keys(extra).forEach(function (k) { n[k] = extra[k]; });
    return n;
  }

  /** vendorMap → 비중(%) 내림차순 배열 */
  function vendorShares(node, basis) {
    basis = basis || "amt";
    var total = node[basis] || 0;
    var list = Object.keys(node.vendorMap).map(function (k) {
      var v = node.vendorMap[k];
      return {
        vendor: v.vendor, qty: v.qty, amt: v.amt,
        share: total > 0 ? (v[basis] / total) * 100 : 0
      };
    });
    list.sort(function (a, b) { return b[basis] - a[basis]; });
    return list;
  }

  /**
   * 톤급 → 모델 → 품번 계층 트리 (각 노드에 업체 집계 포함)
   * 톤급 정렬은 숫자 오름차순(2→3→…→18), 미분류는 맨 뒤.
   */
  function buildTree(records) {
    var tons = {};
    records.forEach(function (r) {
      var tKey = r.ton === null ? "null" : String(r.ton);
      var tNode = tons[tKey] = tons[tKey] || newNode(r.tonLabel, { ton: r.ton, tonCode: r.tonCode });
      sumInto(tNode, r);
      var mNode = tNode.children[r.model] = tNode.children[r.model] || newNode(r.model);
      sumInto(mNode, r);
      var pNode = mNode.children[r.part] = mNode.children[r.part] || newNode(r.part);
      sumInto(pNode, r);
    });
    var list = Object.keys(tons).map(function (k) { return tons[k]; });
    list.sort(function (a, b) {
      if (a.ton === null) return 1;
      if (b.ton === null) return -1;
      return a.ton - b.ton;
    });
    list.forEach(function (t) {
      t.models = Object.keys(t.children).map(function (k) { return t.children[k]; })
        .sort(function (a, b) { return b.amt - a.amt; });
      t.models.forEach(function (m) {
        m.parts = Object.keys(m.children).map(function (k) { return m.children[k]; })
          .sort(function (a, b) { return b.amt - a.amt; });
      });
    });
    return list;
  }

  /**
   * 업체 집중도: 노드의 1위 업체 비중(basis 기준)이 threshold% 이상인
   * 모델/품번 노드를 하이라이트 목록으로 반환.
   */
  function concentration(tree, thresholdPct, basis) {
    basis = basis || "amt";
    var hits = [];
    tree.forEach(function (t) {
      t.models.forEach(function (m) {
        var ms = vendorShares(m, basis);
        if (ms.length && ms[0].share >= thresholdPct) {
          hits.push({ level: "모델", ton: t.name, path: t.name + " > " + m.name,
                      name: m.name, topVendor: ms[0].vendor, share: ms[0].share, amt: m.amt, qty: m.qty });
        }
        m.parts.forEach(function (p) {
          var ps = vendorShares(p, basis);
          if (ps.length && ps[0].share >= thresholdPct) {
            hits.push({ level: "품번", ton: t.name, path: t.name + " > " + m.name + " > " + p.name,
                        name: p.name, topVendor: ps[0].vendor, share: ps[0].share, amt: p.amt, qty: p.qty });
          }
        });
      });
    });
    hits.sort(function (a, b) { return b.share - a.share || b.amt - a.amt; });
    return hits;
  }

  /** 전체 KPI — 구매 원본 기준(모델 중복 없음) */
  function kpis(purchaseRows) {
    var parts = {}, vendors = {}, qty = 0, amt = 0;
    purchaseRows.forEach(function (p) {
      parts[p.part] = true; vendors[p.vendor] = true;
      qty += p.qty; amt += p.amt;
    });
    return {
      totalQty: qty, totalAmt: amt,
      partCount: Object.keys(parts).length,
      vendorCount: Object.keys(vendors).length
    };
  }

  return {
    parseTonCode: parseTonCode,
    tonLabel: tonLabel,
    findColumn: findColumn,
    toNumber: toNumber,
    normalizePurchase: normalizePurchase,
    normalizeModel: normalizeModel,
    joinData: joinData,
    filterRecords: filterRecords,
    buildTree: buildTree,
    vendorShares: vendorShares,
    concentration: concentration,
    kpis: kpis
  };
});
