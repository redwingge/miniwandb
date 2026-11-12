"use strict";

// Final dataset scores are never inferred from the training curves.
const MiniEvaluations = (() => {
  let models = [], signature = "", selectionScope = "", generation = 0, datasets = null;
  function quantile(sorted, p) {
    const index = (sorted.length - 1) * p, low = Math.floor(index), weight = index - low;
    return sorted[low] * (1 - weight) + sorted[Math.ceil(index)] * weight;
  }
  function statistics(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), n = sorted.length;
    if (!n) return {n: 0, mean: null, std: null};
    const mean = sorted.reduce((sum, value) => sum + value / n, 0);
    const std = n > 1 ? Math.sqrt(sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : null;
    const q1 = quantile(sorted, 0.25), median = quantile(sorted, 0.5), q3 = quantile(sorted, 0.75), iqr = q3 - q1;
    return {n, mean, std, min: sorted[0], max: sorted[n - 1], q1, median, q3,
      low: sorted.find(value => value >= q1 - 1.5 * iqr), high: [...sorted].reverse().find(value => value <= q3 + 1.5 * iqr)};
  }
  function series(dataset, metric, name) {
    return models.map(model => {
      const points = model.records.filter(record => record.dataset === dataset && record.name === name && Number.isFinite(record.metrics[metric]))
        .map(record => ({...record, value: record.metrics[metric]}));
      return {...model, points, stats: statistics(points.map(point => point.value))};
    });
  }
  function options(id, values, preferred) {
    const select = $(id), previous = select.value;
    select.replaceChildren();
    for (const value of values) { const option = element("option", "", value); option.value = value; select.append(option); }
    select.value = values.includes(previous) ? previous : values.includes(preferred) ? preferred : values[0] || "";
    select.disabled = !values.length;
  }
  function selectors() {
    options("evaluation-name", [...new Set(models.flatMap(model => model.records.map(record => record.name)))].sort(), "final");
    const records = models.flatMap(model => model.records).filter(record => record.name === $("evaluation-name").value);
    options("evaluation-metric", [...new Set(records.flatMap(record => Object.keys(record.metrics)))].sort(), "mcc");
    const available = [...new Set(records.map(record => record.dataset))].sort();
    if (datasets === null) datasets = new Set(available);
    const holder = $("evaluation-datasets"); holder.replaceChildren(element("span", "", "测试集"));
    for (const dataset of available) {
      const label = element("label"), input = element("input"); input.type = "checkbox"; input.checked = datasets.has(dataset);
      input.addEventListener("change", () => { if (input.checked) datasets.add(dataset); else datasets.delete(dataset); draw(); });
      label.append(input, element("span", "", dataset)); holder.append(label);
    }
    draw();
  }
  function wrapped(text, limit = 80) { return String(text).match(new RegExp(`[\\s\\S]{1,${limit}}`, "g")) || [""]; }
  function plot(dataset, metric, name, rows, kind, compact = false) {
    const width = compact ? Math.max(420, rows.length * 76 + 64) : Math.max(760, rows.length * 130 + 100);
    const left = compact ? 48 : 76, right = width - (compact ? 18 : 28), top = compact ? 18 : 83, bottom = compact ? 208 : 355;
    const legendLines = rows.map(row => wrapped(`${row.project} / ${row.name} [${row.id}]`));
    const height = compact ? 260 : 445 + legendLines.reduce((sum, lines) => sum + lines.length * 20 + 9, 0);
    const svg = svgElement("svg", {xmlns: "http://www.w3.org/2000/svg", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${dataset}/${metric} ${kind === "bar" ? "均值柱状图和标准差" : "k-fold 箱线图"}`, "font-family": "Arial, sans-serif"});
    svg.style.minWidth = compact ? `${Math.max(280, rows.length * 65 + 64)}px` : `${Math.max(650, rows.length * 105 + 100)}px`;
    svg.dataset.compact = String(compact);
    svg.append(svgElement("rect", {width, height, fill: "#ffffff"}));
    if (!compact) {
      svg.append(svgElement("text", {x: left, y: 30, fill: "#263e49", "font-size": 18, "font-weight": 700}, `${dataset} / ${metric}`));
      svg.append(svgElement("text", {x: left, y: 53, fill: "#758c94", "font-size": 12}, `评估版本：${name} · ${kind === "bar" ? "柱高为均值，误差棒为样本标准差（ddof=1）" : "箱体 Q1–Q3，中线为中位数，须为 1.5×IQR 内的最远点"}`));
    }
    const bounds = rows.flatMap(row => row.stats.n ? [row.stats.min, row.stats.max,
      ...(kind === "bar" ? [row.stats.mean - (row.stats.std || 0), row.stats.mean + (row.stats.std || 0), 0] : [])] : []);
    let min = bounds.length ? Math.min(...bounds) : 0, max = bounds.length ? Math.max(...bounds) : 1;
    const padding = (max - min || Math.abs(max) * 0.1 || 1) * 0.12;
    if (kind === "bar" && min >= 0) { min = 0; max += padding; }
    else if (kind === "bar" && max <= 0) { min -= padding; max = 0; }
    else { min -= padding; max += padding; }
    const y = value => bottom - (value - min) / (max - min) * (bottom - top);
    const ticks = compact ? 4 : 5;
    for (let i = 0; i <= ticks; i++) {
      const value = min + (max - min) * i / ticks, yy = y(value);
      svg.append(svgElement("line", {x1: left, x2: right, y1: yy, y2: yy, stroke: "#e8eef0"}));
      svg.append(svgElement("text", {x: left - 9, y: yy + 4, "text-anchor": "end", fill: "#8a9b98", "font-size": compact ? 10 : 12}, compact ? Number(value.toPrecision(3)).toString() : format(value)));
    }
    const line = (x1, x2, y1, y2, paint, stroke = 2) => svg.append(svgElement("line", {x1, x2, y1, y2, stroke: paint, "stroke-width": stroke}));
    if (kind === "bar") line(left, right, y(0), y(0), "#b5c6ce", 1);
    rows.forEach((row, index) => {
      const x = left + (right - left) * (index + 0.5) / rows.length, paint = color(row.id), s = row.stats;
      const half = compact ? 17 : 27, cap = compact ? 10 : 17;
      if (s.n > 1 && kind === "box") {
        line(x, x, y(s.low), y(s.high), paint);
        line(x - cap, x + cap, y(s.low), y(s.low), paint); line(x - cap, x + cap, y(s.high), y(s.high), paint);
        svg.append(svgElement("rect", {x: x - half, y: y(s.q3), width: half * 2, height: Math.max(1, y(s.q1) - y(s.q3)), fill: paint, "fill-opacity": 0.14, stroke: paint, "stroke-width": compact ? 1.5 : 2}));
        line(x - half, x + half, y(s.median), y(s.median), paint, compact ? 2 : 3);
      } else if (s.n && kind === "bar") {
        svg.append(svgElement("rect", {x: x - half, y: Math.min(y(0), y(s.mean)), width: half * 2, height: Math.max(1, Math.abs(y(0) - y(s.mean))), fill: paint, "fill-opacity": compact ? 0.23 : 0.38, stroke: paint}));
        if (s.std !== null) {
          line(x, x, y(s.mean - s.std), y(s.mean + s.std), paint);
          for (const value of [s.mean - s.std, s.mean + s.std]) line(x - cap, x + cap, y(value), y(value), paint);
        }
      }
      row.points.forEach((point, i) => {
        const xx = x + (i - (s.n - 1) / 2) * Math.min(8, 36 / Math.max(1, s.n - 1));
        const dot = svgElement("circle", {cx: xx, cy: y(point.value), r: compact ? 3.2 : 4.3, fill: paint, stroke: "white", "stroke-width": 1, tabindex: 0});
        dot.append(svgElement("title", {}, `${row.name} · ${point.run_name} [${point.run_id}]\n${dataset}/${metric} = ${point.value}\n${point.fold === null ? "独立实验" : `fold ${point.fold}`} · ${point.name}`));
        svg.append(dot);
      });
      if (!s.n) svg.append(svgElement("text", {x, y: (top + bottom) / 2, "text-anchor": "middle", fill: "#a6b0b5", "font-size": 12}, "缺失结果"));
      const short = compact ? `M${index + 1}` : row.name.length > 16 ? row.name.slice(0, 15) + "…" : row.name;
      const label = svgElement("text", {x, y: bottom + (compact ? 20 : 24), "text-anchor": "middle", fill: paint, "font-size": compact ? 11 : 12, "font-weight": 600}, short);
      label.append(svgElement("title", {}, `${row.project} / ${row.name} [${row.id}]`)); svg.append(label);
      svg.append(svgElement("text", {x, y: bottom + (compact ? 36 : 43), "text-anchor": "middle", fill: "#94a49d", "font-size": compact ? 9 : 11}, `n=${s.n}/${row.n_splits}${s.n === 1 ? " · 单点" : ""}`));
    });
    if (compact) return svg;
    let legendY = 428;
    svg.append(svgElement("text", {x: left, y: legendY - 7, fill: "#72868d", "font-size": 11}, "每点为一个 fold 或独立实验的最终得分；缺失不补零。n<2 不计算标准差。"));
    rows.forEach((row, i) => {
      legendY += 20;
      line(left, left + 20, legendY - 4, legendY - 4, color(row.id), 3);
      for (const text of legendLines[i]) { svg.append(svgElement("text", {x: left + 31, y: legendY, fill: color(row.id), "font-size": 12}, text)); legendY += 20; }
      legendY += 9;
    });
    // Grow for complete legends, including arbitrarily long model/group names.
    svg.setAttribute("height", legendY + 8); svg.setAttribute("viewBox", `0 0 ${width} ${legendY + 8}`);
    svg.firstChild?.setAttribute("height", legendY + 8);
    return svg;
  }
  function save(blob, filename) {
    const url = URL.createObjectURL(blob), link = element("a"); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function download(svg, title, type) {
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], {type: "image/svg+xml;charset=utf-8"});
    const filename = title.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 110);
    if (type === "svg") { save(blob, filename + ".svg"); return; }
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("PNG 生成失败，请使用 SVG 导出")); image.src = url; });
      const width = Number(svg.getAttribute("width")), height = Number(svg.getAttribute("height"));
      const scale = Math.min(2, 16000 / width, 16000 / height, Math.sqrt(50000000 / (width * height)));
      const canvas = element("canvas"); canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
      const context = canvas.getContext("2d"); if (!context) throw new Error("浏览器不支持 PNG，请导出 SVG");
      context.scale(scale, scale); context.drawImage(image, 0, 0, width, height);
      const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png")); if (!png) throw new Error("PNG 导出失败");
      save(png, filename + ".png");
    } finally { URL.revokeObjectURL(url); }
  }
  function showError(error) { $("evaluation-error").hidden = false; $("evaluation-error").textContent = error.message; }
  function modelLegend() {
    const holder = $("evaluation-model-legend");
    const expanded = new Set(Array.from(holder.children).filter(node => node.dataset.expanded === "true").map(node => node.dataset.model));
    const nodes = models.map((model, index) => {
      const button = element("button", "evaluation-model"), label = element("span", "evaluation-model-name", model.name);
      button.type = "button"; button.dataset.model = model.id; button.dataset.expanded = String(expanded.has(model.id));
      button.style.color = color(model.id); button.title = `${model.project} / ${model.name} [${model.id}] · 点击展开或收起名称`;
      button.setAttribute("aria-expanded", button.dataset.expanded);
      button.append(element("strong", "evaluation-model-index", `M${index + 1}`), label);
      button.addEventListener("click", () => { button.dataset.expanded = String(button.dataset.expanded !== "true"); button.setAttribute("aria-expanded", button.dataset.expanded); });
      return button;
    });
    holder.replaceChildren(...nodes); $("evaluation-models").hidden = !models.length || !$("evaluation-metric").value;
    $("evaluation-model-count").textContent = `${models.length} 个模型组 · 点击名称可展开`;
  }
  function draw() {
    const holder = $("evaluation-charts"), tableHolder = $("evaluation-table");
    const previous = new Map(Array.from(holder.children).map(node => [node.dataset.dataset, node.open])), cards = [];
    const name = $("evaluation-name").value, metric = $("evaluation-metric").value;
    const available = new Set(models.flatMap(model => model.records.filter(record => record.name === name).map(record => record.dataset)));
    const active = [...(datasets || [])].filter(dataset => available.has(dataset));
    $("evaluation-export").disabled = !metric || !active.length;
    modelLegend();
    $("evaluation-summary-panel").hidden = !metric || !active.length;
    $("evaluation-summary-count").textContent = `${active.length} 个测试集 · ${models.length} 个模型组`;
    if (!metric) { holder.replaceChildren(); tableHolder.replaceChildren(); return; }
    const table = element("table", "evaluation-summary-table"), head = element("thead"), row = element("tr");
    for (const label of ["测试集 / 指标", "模型 / CV 组", "参与折数", "均值 ± 标准差", "中位数", "范围"]) row.append(element("th", "", label));
    head.append(row); table.append(head); const body = element("tbody"); table.append(body);
    for (const dataset of active) {
      const rows = series(dataset, metric, name), card = element("details", "evaluation-card"); card.dataset.dataset = dataset;
      card.open = previous.get(dataset) ?? true;
      const heading = element("summary", "evaluation-card-heading"); heading.append(element("h3", "", dataset), element("span", "evaluation-metric-pill", metric));
      const kind = $("evaluation-plot").value;
      const svg = plot(dataset, metric, name, rows, kind, true);
      for (const type of ["svg", "png"]) {
        const button = element("button", "chart-export", type.toUpperCase());
        button.addEventListener("click", async event => { event.preventDefault(); event.stopPropagation(); button.disabled = true; try { await download(plot(dataset, metric, name, rows, kind), `${dataset}_${metric}_${name}_${kind}`, type); } catch (error) { showError(error); } finally { button.disabled = false; } });
        heading.append(button);
      }
      const scroll = element("div", "evaluation-plot-scroll"); scroll.append(svg);
      const scores = element("div", "evaluation-score-strip");
      rows.forEach((model, index) => { const item = element("span", "evaluation-score"); item.style.color = color(model.id); item.title = `${model.name} · 均值 ± 样本标准差`;
        item.append(element("span", "", `M${index + 1}`), element("strong", "", model.stats.n ? `${format(model.stats.mean)} ± ${format(model.stats.std)}` : "—")); scores.append(item); });
      card.append(heading, scroll, scores); cards.push(card);
      for (const model of rows) {
        const tr = element("tr"), s = model.stats;
        const values = [`${dataset}/${metric}`, `${model.project} / ${model.name}`, `${s.n}/${model.n_splits}`, s.n ? `${format(s.mean)} ± ${format(s.std)}` : "—", format(s.median), s.n ? `${format(s.min)} – ${format(s.max)}` : "—"];
        for (const value of values) tr.append(element("td", "", value));
        tr.children[1].title = model.id; tr.children[1].style.color = color(model.id); body.append(tr);
      }
    }
    holder.replaceChildren(...cards);
    tableHolder.replaceChildren(...(active.length ? [table] : []));
  }
  function csv() {
    const name = $("evaluation-name").value, metric = $("evaluation-metric").value;
    const rows = [["model_group", "group_id", "project", "dataset", "evaluation", "metric", "n", "n_splits", "mean", "std_ddof1", "median", "q1", "q3", "run_id", "run_name", "fold", "value", "metadata"]];
    for (const dataset of datasets || []) for (const model of series(dataset, metric, name)) {
      for (const point of model.points) rows.push([model.name, model.id, model.project, dataset, name, metric,
        model.stats.n, model.n_splits, model.stats.mean, model.stats.std, model.stats.median, model.stats.q1, model.stats.q3,
        point.run_id, point.run_name, point.fold, point.value, JSON.stringify(point.metadata)]);
      if (!model.points.length) rows.push([model.name, model.id, model.project, dataset, name, metric, 0, model.n_splits]);
    }
    const escape = value => { let text = value == null ? "" : String(value); if (typeof value === "string" && /^[=+@\-\t\r]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
    return "\ufeff" + rows.map(row => Array.from({length: rows[0].length}, (_, i) => escape(row[i])).join(",")).join("\r\n");
  }
  async function update() {
    const ids = [...state.selected].sort();
    const scope = JSON.stringify([ids, state.trash]), changedSelection = selectionScope !== scope;
    selectionScope = scope;
    const next = JSON.stringify([ids, state.trash, state.runs.map(run => [run.id, run.status, run.created_at, run.evaluations_updated_at, run.cv])]);
    if (next === signature) return;
    signature = next; const version = ++generation; $("evaluation-error").hidden = true;
    if (!ids.length) { models = []; datasets = null; selectors(); $("evaluation-status").textContent = "勾选实验后查看最终评估"; return; }
    $("evaluation-status").textContent = "读取最终评估…";
    // Only clear when selection changes; background updates retain their current height.
    if (changedSelection) { models = []; datasets = null; selectors(); }
    try {
      const payload = await post("/api/evaluations/compare", {ids, trashed: state.trash});
      if (version !== generation) return;
      if (JSON.stringify(models) !== JSON.stringify(payload.models)) {
        const hadRecords = models.some(model => model.records.length);
        models = payload.models;
        if (changedSelection || !hadRecords) datasets = null;
        selectors();
      }
      const count = models.reduce((sum, model) => sum + model.records.length, 0);
      $("evaluation-status").textContent = count ? `${models.length} 个模型组 · ${count} 份最终评估` : "尚未保存最终评估";
      $("evaluation-help").textContent = count ? "按测试集分别比较所选记录所属的完整 CV 组。每折使用最近成功完成的记录或「用于统计」指定记录；所选记录无最终评估时不回退到旧重跑。指标名称区分大小写；不同评估版本分开比较。" : '使用 run.log_evaluation("test_1580", {"sp": sp, "mcc": mcc}) 单独保存；已有 CSV 结果也可读取后关联到原实验。';
    } catch (error) { if (version === generation) { signature = ""; $("evaluation-status").textContent = "读取失败"; showError(error); } }
  }
  function init() {
    $("evaluation-name").addEventListener("change", () => { datasets = null; selectors(); });
    $("evaluation-metric").addEventListener("change", draw);
    $("evaluation-plot").addEventListener("change", draw);
    $("evaluation-export").addEventListener("click", () => save(new Blob([csv()], {type: "text/csv;charset=utf-8"}), "final_evaluations.csv"));
  }
  return {init, update, statistics, series, plot, csv};
})();
