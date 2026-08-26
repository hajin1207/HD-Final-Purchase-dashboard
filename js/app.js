/* 대시보드 UI — analysis.js(순수 로직)와 분리 */
(function () {
  "use strict";
  var A = window.Analysis;

  var PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
  var OTHER_COLOR = "#c3c2b7";

  var state = {
    purchase: null,   // 표준화된 구매 레코드
    model: null,      // 표준화된 모델 레코드
    records: null,    // 조인 결과
    unmatched: [],
    basis: "amt",     // amt | qty
    filters: { ton: "", model: "", vendor: "" },
    threshold: 50,
    vendorColor: {},  // 업체명 → 색 (전체 구매액 순 고정 배정)
    charts: {}
  };

  // ---------- 유틸 ----------
  function $(id) { return document.getElementById(id); }
  function fmt(n) { return Math.round(n).toLocaleString("ko-KR"); }
  function fmtAmt(n) {
    if (Math.abs(n) >= 1e8) return (n / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 1 }) + "억원";
    if (Math.abs(n) >= 1e4) return (n / 1e4).toLocaleString("ko-KR", { maximumFractionDigits: 0 }) + "만원";
    return fmt(n) + "원";
  }
  function basisLabel() { return state.basis === "amt" ? "구매 금액" : "구매 물량"; }
  function basisValue(node) { return state.basis === "amt" ? node.amt : node.qty; }
  function fmtBasis(v) { return state.basis === "amt" ? fmtAmt(v) : fmt(v) + "개"; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------- 데이터 로드 ----------
  function readSheet(file, cb) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        var ws = wb.Sheets[wb.SheetNames[0]];
        cb(null, XLSX.utils.sheet_to_json(ws, { defval: "" }));
      } catch (err) { cb(err); }
    };
    reader.onerror = function () { cb(new Error("파일을 읽지 못했습니다.")); };
    reader.readAsArrayBuffer(file);
  }

  function setStatus(el, ok, msg) {
    el.className = ok ? "file-ok" : "file-err";
    el.textContent = msg;
  }

  /** 정상 로드 메시지에 검증 경고(음수 제외 등)를 덧붙인다 */
  function withWarnings(msg, r) {
    if (r.warnings && r.warnings.length) msg += "\n⚠ " + r.warnings.join("\n⚠ ");
    return msg;
  }

  function tryBuild() {
    if (!state.purchase || !state.model) return;
    var joined = A.joinData(state.purchase, state.model);
    state.records = joined.records;
    state.unmatched = joined.unmatchedParts;
    assignVendorColors();
    state.filters = { ton: "", model: "", vendor: "" };
    $("dash").style.display = "";
    $("empty-state").style.display = "none";
    buildFilterOptions();
    render();
  }

  function assignVendorColors() {
    var totals = {};
    state.purchase.forEach(function (p) { totals[p.vendor] = (totals[p.vendor] || 0) + p.amt; });
    var sorted = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
    state.vendorColor = {};
    sorted.forEach(function (v, i) {
      state.vendorColor[v] = i < PALETTE.length ? PALETTE[i] : OTHER_COLOR;
    });
  }

  function loadSample() {
    var d = window.SAMPLE_DATA;
    var p = A.normalizePurchase(d.purchase);
    var m = A.normalizeModel(d.model);
    state.purchase = p.rows;
    state.model = m.rows;
    setStatus($("purchase-status"), true, withWarnings("샘플 구매 데이터 " + p.rows.length + "행 로드됨", p));
    setStatus($("model-status"), true, "샘플 모델 데이터 " + m.rows.length + "행 로드됨");
    tryBuild();
  }

  // ---------- 필터 ----------
  function buildFilterOptions() {
    var tons = {}, models = {}, vendors = {};
    state.records.forEach(function (r) {
      if (r.ton !== null) tons[r.ton] = r.tonLabel;
      models[r.model] = true;
      vendors[r.vendor] = true;
    });
    fillSelect($("f-ton"), Object.keys(tons).map(Number).sort(function (a, b) { return a - b; })
      .map(function (t) { return { v: t, t: tons[t] }; }));
    fillSelect($("f-model"), Object.keys(models).sort().map(function (m) { return { v: m, t: m }; }));
    fillSelect($("f-vendor"), Object.keys(vendors).sort().map(function (v) { return { v: v, t: v }; }));
  }
  function fillSelect(sel, items) {
    sel.length = 1;
    items.forEach(function (it) {
      var o = document.createElement("option");
      o.value = it.v; o.textContent = it.t;
      sel.appendChild(o);
    });
  }

  function currentRecords() { return A.filterRecords(state.records, state.filters); }

  // ---------- 렌더 ----------
  function render() {
    var recs = currentRecords();
    var tree = A.buildTree(recs);
    var hits = A.concentration(tree, state.threshold, state.basis);
    renderKpis(hits);
    renderTonChart(tree);
    renderVendorChart(recs);
    renderTree(tree);
    renderConcTable(hits);
    $("dup-note").textContent = state.unmatched.length
      ? "※ 모델 데이터에 없는 품번 " + state.unmatched.length + "개는 '미분류'로 표시됩니다. 1:N 품번(여러 모델 적용)은 기획서 기준에 따라 모든 모델에 중복 집계됩니다. 상단 KPI는 구매 원본 기준(중복 없음)입니다."
      : "※ 1:N 품번(여러 모델 적용)은 기획서 기준에 따라 모든 모델에 중복 집계됩니다. 상단 KPI는 구매 원본 기준(중복 없음)입니다.";
  }

  function renderKpis(hits) {
    var k = A.kpis(state.purchase);
    var row = $("kpi-row");
    row.innerHTML = "";
    [
      { label: "연간 구매 금액 (전체)", value: fmtAmt(k.totalAmt) },
      { label: "연간 구매 물량 (전체)", value: fmt(k.totalQty), unit: "개" },
      { label: "품번 수", value: fmt(k.partCount), unit: "개" },
      { label: "협력업체 수", value: fmt(k.vendorCount), unit: "개사" },
      { label: "집중도 경고 (" + state.threshold + "%↑, 현재 필터)", value: fmt(hits.length), unit: "건", alert: hits.length > 0 }
    ].forEach(function (t) {
      var d = document.createElement("div");
      d.className = "kpi" + (t.alert ? " alert" : "");
      d.innerHTML = '<div class="label">' + esc(t.label) + '</div><div class="value">' + esc(t.value)
        + (t.unit ? '<span class="unit">' + t.unit + "</span>" : "") + "</div>";
      row.appendChild(d);
    });
  }

  function destroyChart(key) {
    if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
  }

  function renderTonChart(tree) {
    $("ton-chart-title").textContent = "톤급별 " + basisLabel();
    var labels = tree.map(function (t) { return t.name; });
    var data = tree.map(function (t) { return basisValue(t); });
    destroyChart("ton");
    state.charts.ton = new Chart($("chart-ton"), {
      type: "bar",
      data: { labels: labels, datasets: [{ data: data, backgroundColor: "#2a78d6",
        borderRadius: { topLeft: 4, topRight: 4 }, maxBarThickness: 42 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) { return basisLabel() + ": " + fmtBasis(c.parsed.y); } } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#52514e" }, border: { color: "#c3c2b7" } },
          y: { grid: { color: "#e1e0d9" }, border: { display: false },
               ticks: { color: "#898781", callback: function (v) { return state.basis === "amt" ? fmtAmt(v) : fmt(v); } } }
        },
        onClick: function (evt, els) {
          if (!els.length) return;
          var t = tree[els[0].index];
          if (t.ton === null) return;
          $("f-ton").value = String(t.ton);
          state.filters.ton = String(t.ton);
          render();
        }
      }
    });
  }

  function renderVendorChart(recs) {
    var scope = [];
    if (state.filters.ton) scope.push($("f-ton").selectedOptions[0].textContent);
    if (state.filters.model) scope.push(state.filters.model);
    $("vendor-chart-title").textContent = "업체별 " + basisLabel() + " 비중 — " + (scope.length ? scope.join(" · ") : "전체");

    var node = { qty: 0, amt: 0, vendorMap: {} };
    // 업체 비중은 1:N 조인 중복을 피하려 구매 원본 행(srcIdx) 단위로 유일화
    // (품번+업체 키는 동일 품번·업체 조합이 여러 행일 때 물량·금액이 누락될 수 있음)
    var seen = {};
    recs.forEach(function (r) {
      var key = r.srcIdx !== undefined ? "i" + r.srcIdx : r.part + " " + r.vendor;
      if (seen[key]) return;
      seen[key] = true;
      node.qty += r.qty; node.amt += r.amt;
      var v = node.vendorMap[r.vendor] = node.vendorMap[r.vendor] || { vendor: r.vendor, qty: 0, amt: 0 };
      v.qty += r.qty; v.amt += r.amt;
    });
    var shares = A.vendorShares(node, state.basis);
    var top = shares.slice(0, 8);
    var rest = shares.slice(8);
    var labels = top.map(function (s) { return s.vendor; });
    var data = top.map(function (s) { return s.share; });
    var colors = top.map(function (s) { return state.vendorColor[s.vendor] || OTHER_COLOR; });
    if (rest.length) {
      labels.push("기타 " + rest.length + "개사");
      data.push(rest.reduce(function (a, s) { return a + s.share; }, 0));
      colors.push(OTHER_COLOR);
    }
    $("vendor-chart-note").textContent = rest.length ? "상위 8개사 외 " + rest.length + "개사는 '기타'로 묶어 표시합니다. 상세는 드릴다운 표 참조." : "";
    destroyChart("vendor");
    state.charts.vendor = new Chart($("chart-vendor"), {
      type: "doughnut",
      data: { labels: labels, datasets: [{ data: data, backgroundColor: colors, borderColor: "#fcfcfb", borderWidth: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "58%",
        plugins: {
          legend: { position: "right", labels: { color: "#52514e", boxWidth: 12, boxHeight: 12 } },
          tooltip: { callbacks: { label: function (c) { return c.label + ": " + c.parsed.toFixed(1) + "%"; } } }
        }
      }
    });
  }

  function shareBarHtml(shares) {
    var html = '<div class="sharebar" title="' +
      esc(shares.slice(0, 5).map(function (s) { return s.vendor + " " + s.share.toFixed(1) + "%"; }).join(", ")) + '">';
    shares.forEach(function (s) {
      var c = state.vendorColor[s.vendor] || OTHER_COLOR;
      html += '<span style="width:' + s.share + '%;background:' + c + '"></span>';
    });
    return html + "</div>";
  }

  function vendorTableHtml(shares) {
    var rows = shares.map(function (s) {
      var c = state.vendorColor[s.vendor] || OTHER_COLOR;
      return "<tr><td><span class='dot' style='background:" + c + "'></span>" + esc(s.vendor) + "</td>" +
        "<td>" + fmt(s.qty) + "</td><td>" + fmtAmt(s.amt) + "</td><td>" + s.share.toFixed(1) + "%</td></tr>";
    }).join("");
    return "<table><thead><tr><th>협력업체</th><th>구매 물량</th><th>구매 금액</th><th>비중(" + basisLabel() + ")</th></tr></thead><tbody>" + rows + "</tbody></table>";
  }

  function hotBadge(shares) {
    return shares.length && shares[0].share >= state.threshold
      ? '<span class="badge">집중 ' + shares[0].share.toFixed(0) + "%</span>" : "";
  }

  function renderTree(tree) {
    var el = $("tree");
    var html = "";
    tree.forEach(function (t) {
      var ts = A.vendorShares(t, state.basis);
      html += "<details><summary><span>" + esc(t.name) +
        (t.tonCode && t.tonCode !== "-" ? " <span class='muted'>(" + esc(t.tonCode) + ")</span>" : "") + "</span>" +
        "<span class='num'>" + fmt(t.qty) + "개</span><span class='num'>" + fmtAmt(t.amt) + "</span>" +
        shareBarHtml(ts) + "</summary>";
      t.models.forEach(function (m) {
        var ms = A.vendorShares(m, state.basis);
        html += "<details><summary class='lv2'><span>" + esc(m.name) + hotBadge(ms) + "</span>" +
          "<span class='num'>" + fmt(m.qty) + "개</span><span class='num'>" + fmtAmt(m.amt) + "</span>" +
          shareBarHtml(ms) + "</summary>";
        m.parts.forEach(function (p) {
          var ps = A.vendorShares(p, state.basis);
          html += "<details><summary class='lv3'><span>" + esc(p.name) + hotBadge(ps) + "</span>" +
            "<span class='num'>" + fmt(p.qty) + "개</span><span class='num'>" + fmtAmt(p.amt) + "</span>" +
            shareBarHtml(ps) + "</summary><div class='vendors'>" + vendorTableHtml(ps) + "</div></details>";
        });
        html += "</details>";
      });
      html += "</details>";
    });
    el.innerHTML = html || "<p class='muted'>표시할 데이터가 없습니다.</p>";
  }

  function renderConcTable(hits) {
    $("conc-hint").textContent = "1위 업체 비중(" + basisLabel() + " 기준) " + state.threshold + "% 이상 — " + hits.length + "건";
    var tb = $("conc-table").querySelector("tbody");
    tb.innerHTML = hits.slice(0, 50).map(function (h) {
      return "<tr class='hot'><td>" + esc(h.level) + "</td><td>" + esc(h.path) + "</td><td>" + esc(h.topVendor) + "</td>" +
        "<td class='num'>" + h.share.toFixed(1) + "%</td><td class='num'>" + fmtAmt(h.amt) + "</td><td class='num'>" + fmt(h.qty) + "</td></tr>";
    }).join("") || "<tr><td colspan='6' class='muted'>기준을 넘는 항목이 없습니다.</td></tr>";
  }

  // ---------- 보고서 ----------
  function buildReport() {
    var recs = currentRecords();
    var tree = A.buildTree(recs);
    var hits = A.concentration(tree, state.threshold, state.basis);
    var k = A.kpis(state.purchase);
    var today = new Date();
    var dateStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");

    var html = "<h1>구매 분석 요약 보고서</h1>" +
      "<p>작성일: " + dateStr + " · 집계 기준: " + basisLabel() + " · 집중도 경고 기준: " + state.threshold + "%</p>" +
      "<h2>1. 전체 현황</h2><table class='flat'><tbody>" +
      "<tr><td>연간 구매 금액</td><td class='num'>" + fmtAmt(k.totalAmt) + "</td></tr>" +
      "<tr><td>연간 구매 물량</td><td class='num'>" + fmt(k.totalQty) + "개</td></tr>" +
      "<tr><td>품번 수 / 협력업체 수</td><td class='num'>" + fmt(k.partCount) + "개 / " + fmt(k.vendorCount) + "개사</td></tr></tbody></table>";

    html += "<h2>2. 톤급별 구매 규모</h2><table class='flat'><thead><tr><th>톤급</th><th class='num'>구매 물량</th><th class='num'>구매 금액</th><th>상위 업체(비중)</th></tr></thead><tbody>";
    tree.forEach(function (t) {
      var s = A.vendorShares(t, state.basis).slice(0, 3)
        .map(function (x) { return esc(x.vendor) + " " + x.share.toFixed(1) + "%"; }).join(", ");
      html += "<tr><td>" + esc(t.name) + "</td><td class='num'>" + fmt(t.qty) + "</td><td class='num'>" + fmtAmt(t.amt) + "</td><td>" + s + "</td></tr>";
    });
    html += "</tbody></table>";

    html += "<h2>3. 모델별 업체 공급 비중 (상위 20개 모델, " + basisLabel() + "순)</h2><table class='flat'><thead><tr><th>톤급</th><th>모델</th><th class='num'>구매 금액</th><th>업체 비중</th></tr></thead><tbody>";
    var models = [];
    tree.forEach(function (t) { t.models.forEach(function (m) { models.push({ t: t, m: m }); }); });
    models.sort(function (a, b) { return basisValue(b.m) - basisValue(a.m); });
    models.slice(0, 20).forEach(function (x) {
      var s = A.vendorShares(x.m, state.basis).slice(0, 4)
        .map(function (v) { return esc(v.vendor) + " " + v.share.toFixed(1) + "%"; }).join(", ");
      html += "<tr><td>" + esc(x.t.name) + "</td><td>" + esc(x.m.name) + "</td><td class='num'>" + fmtAmt(x.m.amt) + "</td><td>" + s + "</td></tr>";
    });
    html += "</tbody></table>";

    html += "<h2>4. 업체 집중도 상위 항목 (" + state.threshold + "% 이상, 상위 30건)</h2><table class='flat'><thead><tr><th>구분</th><th>경로</th><th>1위 업체</th><th class='num'>비중</th><th class='num'>구매 금액</th></tr></thead><tbody>";
    hits.slice(0, 30).forEach(function (h) {
      html += "<tr><td>" + esc(h.level) + "</td><td>" + esc(h.path) + "</td><td>" + esc(h.topVendor) + "</td><td class='num'>" + h.share.toFixed(1) + "%</td><td class='num'>" + fmtAmt(h.amt) + "</td></tr>";
    });
    html += "</tbody></table>";
    $("report").innerHTML = html;
  }

  // ---------- 엑셀 내보내기 ----------
  function exportExcel() {
    var recs = currentRecords();
    var tree = A.buildTree(recs);
    var hits = A.concentration(tree, state.threshold, state.basis);
    var wb = XLSX.utils.book_new();

    var tonRows = tree.map(function (t) {
      var top = A.vendorShares(t, state.basis)[0];
      return { "톤급": t.name, "구매 물량": t.qty, "구매 금액": t.amt,
        "1위 업체": top ? top.vendor : "", "1위 비중(%)": top ? +top.share.toFixed(1) : "" };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tonRows), "톤급별");

    var modelRows = [];
    tree.forEach(function (t) {
      t.models.forEach(function (m) {
        A.vendorShares(m, state.basis).forEach(function (v) {
          modelRows.push({ "톤급": t.name, "모델": m.name, "업체": v.vendor,
            "구매 물량": v.qty, "구매 금액": v.amt, "비중(%)": +v.share.toFixed(1) });
        });
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(modelRows), "모델×업체");

    var concRows = hits.map(function (h) {
      return { "구분": h.level, "경로": h.path, "1위 업체": h.topVendor,
        "비중(%)": +h.share.toFixed(1), "구매 금액": h.amt, "구매 물량": h.qty };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(concRows), "집중도");

    XLSX.writeFile(wb, "구매분석_결과.xlsx");
  }

  // ---------- 이벤트 ----------
  $("btn-sample").addEventListener("click", loadSample);

  $("file-purchase").addEventListener("change", function (e) {
    var f = e.target.files[0];
    if (!f) return;
    readSheet(f, function (err, rows) {
      if (err) return setStatus($("purchase-status"), false, String(err.message || err));
      var r = A.normalizePurchase(rows);
      if (r.errors.length) return setStatus($("purchase-status"), false, r.errors.join("\n"));
      state.purchase = r.rows;
      setStatus($("purchase-status"), true, withWarnings(f.name + " — " + r.rows.length + "행 인식됨", r));
      tryBuild();
    });
  });

  $("file-model").addEventListener("change", function (e) {
    var f = e.target.files[0];
    if (!f) return;
    readSheet(f, function (err, rows) {
      if (err) return setStatus($("model-status"), false, String(err.message || err));
      var r = A.normalizeModel(rows);
      if (r.errors.length) return setStatus($("model-status"), false, r.errors.join("\n"));
      state.model = r.rows;
      setStatus($("model-status"), true, f.name + " — " + r.rows.length + "행 인식됨");
      tryBuild();
    });
  });

  ["f-ton", "f-model", "f-vendor"].forEach(function (id) {
    $(id).addEventListener("change", function () {
      state.filters = { ton: $("f-ton").value, model: $("f-model").value, vendor: $("f-vendor").value };
      render();
    });
  });
  $("f-threshold").addEventListener("change", function () {
    var v = parseFloat($("f-threshold").value);
    state.threshold = isNaN(v) ? 50 : Math.min(100, Math.max(1, v));
    render();
  });
  $("btn-reset").addEventListener("click", function () {
    state.filters = { ton: "", model: "", vendor: "" };
    $("f-ton").value = ""; $("f-model").value = ""; $("f-vendor").value = "";
    render();
  });
  $("basis-amt").addEventListener("click", function () { setBasis("amt"); });
  $("basis-qty").addEventListener("click", function () { setBasis("qty"); });
  function setBasis(b) {
    state.basis = b;
    $("basis-amt").classList.toggle("on", b === "amt");
    $("basis-qty").classList.toggle("on", b === "qty");
    render();
  }
  $("btn-print").addEventListener("click", function () { buildReport(); window.print(); });
  $("btn-export").addEventListener("click", exportExcel);
})();
