"use strict";

// Offline SVG charts, grouped metrics, zooming and self-contained image exports.
const MiniCharts = (() => {
  const box = {width: 640, height: 300, left: 72, right: 624, top: 18, bottom: 250};
  const views = new Map();
  const styles = new Map();
  const interactions = new Set();
  const interactionGroups = new Map();
  const closers = new Map();
  let pendingRender = null;
  let groupNodes = [];
  let renderedContainer = null, renderedShape = "";
  const liveCards = new Map();
  let serial = 0;
  let collapsed;
  try { collapsed = new Set(JSON.parse(localStorage.getItem("miniwandb.collapsed-groups") || "[]")); }
  catch (_) { collapsed = new Set(); }
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") for (const close of [...closers.values()]) close();
  });

  function rememberGroups() {
    try { localStorage.setItem("miniwandb.collapsed-groups", JSON.stringify([...collapsed])); } catch (_) {}
  }
  function parts(metric) {
    const split = metric.indexOf("/");
    return split > 0 ? {group: metric.slice(0, split), name: metric.slice(split + 1) || metric} : {group: "其他指标", name: metric};
  }
  function style(run) {
    if (!styles.has(run.id)) styles.set(run.id, {color: color(run.id), dash: ["", "8 3", "2 3", "9 3 2 3"][Math.floor(styles.size / 8) % 4]});
    return styles.get(run.id);
  }
  function viewKey(metric, options) { return `${options.axis}\n${metric}`; }
  function endInteraction(key) {
    interactions.delete(key);
    if (!interactions.size && pendingRender) {
      const pending = pendingRender; pendingRender = null;
      render(...pending);
    }
  }
  function bounds(series) {
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const item of series) for (const p of item.points) {
      if (!Number.isFinite(p.y) || !Number.isFinite(p.x)) continue;
      xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x);
      ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y);
    }
    if (!Number.isFinite(xmin)) return null;
    if (xmin === xmax) { xmin -= 0.5; xmax += 0.5; }
    const padding = ymax === ymin ? Math.max(Math.abs(ymin) * 0.1, 0.01) : (ymax - ymin) * 0.08;
    return {xmin, xmax, ymin: ymin - padding, ymax: ymax + padding};
  }
  function lowerBound(points, x) {
    let lo = 0, hi = points.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].x < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function nearest(points, x) {
    const index = lowerBound(points, x);
    const before = points[index - 1], after = points[index];
    if (!before) return after || null;
    if (!after) return before;
    return Math.abs(before.x - x) <= Math.abs(after.x - x) ? before : after;
  }
  function screenPoint(svg, event) {
    const rect = svg.getBoundingClientRect();
    return {x: Math.max(box.left, Math.min(box.right, (event.clientX - rect.left) / rect.width * box.width)),
      y: Math.max(box.top, Math.min(box.bottom, (event.clientY - rect.top) / rect.height * box.height))};
  }
  function selectionRange(range, from, to) {
    if (Math.abs(to.x - from.x) < 8 || Math.abs(to.y - from.y) < 8) return null;
    const x = px => range.xmin + (px - box.left) / (box.right - box.left) * (range.xmax - range.xmin);
    const y = py => range.ymax - (py - box.top) / (box.bottom - box.top) * (range.ymax - range.ymin);
    return {xmin: x(Math.min(from.x, to.x)), xmax: x(Math.max(from.x, to.x)),
      ymin: y(Math.max(from.y, to.y)), ymax: y(Math.min(from.y, to.y))};
  }

  function makePlot(metric, series, options, range) {
    const natural = bounds(series);
    range = range || natural;
    const svg = svgElement("svg", {viewBox: `0 0 ${box.width} ${box.height}`, width: box.width, height: box.height,
      role: "img", "aria-label": `${metric} 曲线`, "font-family": "Arial, PingFang SC, Microsoft YaHei, sans-serif"});
    svg.append(svgElement("rect", {width: box.width, height: box.height, fill: "#ffffff"}));
    if (!natural) {
      svg.append(svgElement("text", {x: 320, y: 140, fill: "#83939d", "font-size": 12, "text-anchor": "middle"}, "当前横轴下没有有效数据；Epoch 轴需要记录 epoch"));
      return {svg, range: null, paths: [], px: () => 0, py: () => 0};
    }
    const px = x => box.left + (x - range.xmin) / (range.xmax - range.xmin) * (box.right - box.left);
    const py = y => box.bottom - (y - range.ymin) / (range.ymax - range.ymin) * (box.bottom - box.top);
    const defs = svgElement("defs", {});
    const clip = svgElement("clipPath", {id: `miniwandb-plot-${++serial}`});
    clip.append(svgElement("rect", {x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top}));
    defs.append(clip); svg.append(defs);
    for (let i = 0; i <= 4; i++) {
      const y = box.top + (box.bottom - box.top) * i / 4;
      svg.append(svgElement("line", {x1: box.left, x2: box.right, y1: y, y2: y, stroke: "#e8eef1", "stroke-width": 1}));
      svg.append(svgElement("text", {x: box.left - 10, y: y + 4, fill: "#8799a4", "font-size": 12, "text-anchor": "end"}, format(range.ymax - (range.ymax - range.ymin) * i / 4)));
      const x = box.left + (box.right - box.left) * i / 4;
      svg.append(svgElement("text", {x, y: box.bottom + 22, fill: "#8799a4", "font-size": 12, "text-anchor": "middle"}, format(range.xmin + (range.xmax - range.xmin) * i / 4)));
    }
    svg.append(svgElement("text", {x: box.right, y: 295, fill: "#8799a4", "font-size": 12, "text-anchor": "end"}, options.axisLabel));
    const lines = svgElement("g", {"clip-path": `url(#${clip.getAttribute("id")})`});
    const paths = [];
    for (const item of series) {
      const paint = style(item.run);
      const start = Math.max(0, lowerBound(item.points, range.xmin) - 1);
      const end = Math.min(item.points.length, lowerBound(item.points, range.xmax) + 1);
      const points = reducePoints(item.points.slice(start, end));
      let d = "", gap = true;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!Number.isFinite(p.y)) { gap = true; continue; }
        d += `${gap ? "M" : "L"}${px(p.x).toFixed(3)},${py(p.y).toFixed(3)} `;
        if (gap && (i + 1 === points.length || !Number.isFinite(points[i + 1].y))) lines.append(svgElement("circle", {cx: px(p.x), cy: py(p.y), r: 3, fill: paint.color}));
        gap = false;
      }
      const path = svgElement("path", {d, fill: "none", stroke: paint.color, "stroke-width": 2,
        "stroke-dasharray": paint.dash, "stroke-linecap": "round", "stroke-linejoin": "round"});
      lines.append(path); paths.push({path, run: item.run});
    }
    svg.append(lines);
    return {svg, range, paths, px, py};
  }

  function wrapText(text, maxWidth, size) {
    const lines = []; let line = "", width = 0;
    for (const char of String(text)) {
      const advance = char.codePointAt(0) > 255 ? size : size * 0.62;
      if (width + advance > maxWidth && line) { lines.push(line); line = ""; width = 0; }
      line += char; width += advance;
    }
    if (line || !lines.length) lines.push(line);
    return lines;
  }
  function exportSVG(entries, options, title) {
    const width = entries.length > 1 ? 1200 : 1000;
    const columns = entries.length > 1 ? 2 : 1;
    const margin = 32, gap = 24, panelWidth = (width - margin * 2 - gap * (columns - 1)) / columns;
    const panelHeight = panelWidth / box.width * box.height + 40;
    const legends = new Map();
    for (const entry of entries) for (const item of entry.getSeries()) legends.set(item.run.id, item.run);
    const legendRows = [...legends.values()].map(run => ({run, lines: wrapText(`${run.project || "default"} / ${run.name}  [${run.id}]`, width - margin * 2 - 48, 15)}));
    const footerY = 86 + Math.ceil(entries.length / columns) * panelHeight;
    const height = footerY + 68 + legendRows.reduce((sum, row) => sum + row.lines.length * 22 + 9, 0);
    const svg = svgElement("svg", {width, height, viewBox: `0 0 ${width} ${height}`, "font-family": "Arial, PingFang SC, Microsoft YaHei, sans-serif"});
    svg.append(svgElement("rect", {width, height, fill: "#ffffff"}));
    svg.append(svgElement("text", {x: margin, y: 36, fill: "#263e49", "font-size": 25, "font-weight": 700}, title));
    svg.append(svgElement("text", {x: margin, y: 61, fill: "#7e919c", "font-size": 14}, `${entries.length} 个指标 · ${legends.size} 个实验 · 当前视图（包含平滑与缩放）`));
    entries.forEach((entry, index) => {
      const x = margin + index % columns * (panelWidth + gap), y = 82 + Math.floor(index / columns) * panelHeight;
      svg.append(svgElement("text", {x, y: y + 17, fill: "#344f5b", "font-size": 17, "font-weight": 600}, `${parts(entry.metric).group} / ${parts(entry.metric).name}`));
      const plot = makePlot(entry.metric, entry.getSeries(), options, views.get(viewKey(entry.metric, options)));
      for (const [key, value] of Object.entries({x, y: y + 26, width: panelWidth, height: panelWidth / box.width * box.height})) plot.svg.setAttribute(key, value);
      svg.append(plot.svg);
    });
    svg.append(svgElement("line", {x1: margin, x2: width - margin, y1: footerY, y2: footerY, stroke: "#dce6eb"}));
    const groups = [...new Set(entries.map(entry => parts(entry.metric).group))].join("、");
    svg.append(svgElement("text", {x: margin, y: footerY + 29, fill: "#3c5c68", "font-size": 15, "font-weight": 600}, `指标组：${groups} · 横轴：${options.axisLabel} · 平滑：${options.smoothing}%`));
    let y = footerY + 58;
    for (const row of legendRows) {
      const paint = style(row.run);
      svg.append(svgElement("line", {x1: margin, x2: margin + 28, y1: y - 5, y2: y - 5, stroke: paint.color, "stroke-width": 3, "stroke-dasharray": paint.dash}));
      row.lines.forEach((line, i) => svg.append(svgElement("text", {x: margin + 41, y: y + i * 22, fill: paint.color, "font-size": 15}, line)));
      y += row.lines.length * 22 + 9;
    }
    return svg;
  }
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = element("a"); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function download(entries, options, title, type) {
    const svg = exportSVG(entries, options, title);
    const text = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([text], {type: "image/svg+xml;charset=utf-8"});
    const filename = title.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 100) || "metrics";
    if (type === "svg") { saveBlob(blob, filename + ".svg"); return; }
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("无法生成图片，请尝试 SVG 导出")); image.src = url; });
      const width = Number(svg.getAttribute("width")), height = Number(svg.getAttribute("height"));
      const scale = Math.min(2, 16000 / width, 16000 / height, Math.sqrt(50000000 / (width * height)));
      const canvas = element("canvas"); canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("浏览器不支持 PNG 导出，请使用 SVG");
      ctx.scale(scale, scale); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height); ctx.drawImage(image, 0, 0, width, height);
      const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (!png) throw new Error("PNG 导出失败，请使用 SVG");
      saveBlob(png, filename + ".png");
    } finally { URL.revokeObjectURL(url); }
  }
  function exportButton(entries, options, title, type, group = false) {
    const button = element("button", "chart-export", `${group ? "整组 " : ""}${type.toUpperCase()}`);
    button.title = `导出${group ? "整组" : "当前曲线"}图片，包含组名称和实验图例`;
    button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation(); button.disabled = true;
      const label = button.textContent; button.textContent = "导出中…";
      try { await download(entries, options, title, type); }
      catch (error) { options.onError(error); }
      finally { button.disabled = false; button.textContent = label; }
    });
    return button;
  }

  function chart(entry, options) {
    const {group, name} = parts(entry.metric);
    let series = entry.getSeries();
    const id = `chart-${++serial}`, key = viewKey(entry.metric, options);
    interactionGroups.set(id, group);
    const card = element("article", "chart-card"); card.dataset.metric = entry.metric;
    const heading = element("div", "chart-title"), title = element("strong", "", name);
    title.title = entry.metric;
    const tools = element("div", "chart-actions"), reset = element("button", "chart-reset", "还原");
    reset.title = "还原完整范围（也可双击图表）";
    tools.append(reset, exportButton([entry], options, `${group} / ${name}`, "png"), exportButton([entry], options, `${group} / ${name}`, "svg"));
    heading.append(title, tools);
    const wrap = element("div", "chart-wrap"), hint = element("div", "chart-hint", "右键拖框放大 · 双击还原 · 点击固定数据浮窗");
    const tooltip = element("div", "curve-tooltip"); tooltip.hidden = true;
    const tooltipHead = element("div", "curve-tooltip-head"), tooltipTitle = element("strong", "", `${group} / ${name}`);
    const tooltipTools = element("div", "curve-tooltip-tools");
    const expand = element("button", "", "展开名称"), pin = element("button", "", "固定"), close = element("button", "", "×");
    close.setAttribute("aria-label", "关闭数据浮窗");
    tooltipTools.append(expand, pin, close); tooltipHead.append(tooltipTitle, tooltipTools);
    const table = element("table", "curve-tooltip-table"), head = element("thead"), headRow = element("tr");
    for (const text of ["Name", "Step", "Value"]) headRow.append(element("th", "", text));
    head.append(headRow); const tbody = element("tbody"); table.append(head, tbody);
    const scroll = element("div", "curve-tooltip-scroll"); scroll.append(table);
    tooltip.append(tooltipHead, scroll);
    let plot, hit, marker, dots, brush, drag = null, pinned = false, expanded = false, hideTimer = null;
    let lastPoint = null;
    function highlight(runId) {
      for (const line of plot.paths) { line.path.setAttribute("stroke-width", runId === line.run.id ? 3 : 2); line.path.setAttribute("opacity", !runId || runId === line.run.id ? 1 : 0.35); }
    }
    function hide() {
      if (pinned || drag) return;
      tooltip.hidden = true;
      if (marker) marker.setAttribute("visibility", "hidden");
      if (dots) dots.replaceChildren();
      if (plot) highlight(null);
      endInteraction(id);
    }
    function laterHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 160); }
    function position(point) {
      const rect = wrap.getBoundingClientRect();
      const width = tooltip.offsetWidth || 330, height = tooltip.offsetHeight || 140;
      const x = point.x / box.width * rect.width, y = point.y / box.height * rect.height;
      const candidates = [
        {left: 5, top: 5}, {left: Math.max(5, rect.width - width - 5), top: 5},
        {left: 5, top: Math.max(5, rect.height - height - 5)},
        {left: Math.max(5, rect.width - width - 5), top: Math.max(5, rect.height - height - 5)},
      ];
      const distance = candidate => Math.hypot(Math.max(candidate.left - x, 0, x - candidate.left - width), Math.max(candidate.top - y, 0, y - candidate.top - height));
      candidates.sort((a, b) => distance(b) - distance(a));
      let chosen = candidates[0];
      // If all corners cover the pointer, place the panel just outside the plot.
      if (distance(chosen) < 12) {
        const viewportHeight = typeof window === "undefined" ? 1000 : window.innerHeight;
        if (rect.top + rect.height + height + 8 < viewportHeight) chosen = {left: Math.max(5, rect.width - width - 5), top: rect.height + 8};
        else if (rect.top > height + 8) chosen = {left: 5, top: -height - 8};
      }
      tooltip.style.left = `${chosen.left}px`; tooltip.style.top = `${chosen.top}px`;
      tooltip.style.right = "auto"; tooltip.style.bottom = "auto";
    }
    const cells = series.map(item => {
      const row = element("tr"), paint = style(item.run);
      const label = element("td", "curve-name", item.run.name), step = element("td", "curve-step"), value = element("td", "curve-value");
      label.title = `${item.run.project} / ${item.run.name} [${item.run.id}]`;
      row.style.color = paint.color; row.append(label, step, value); tbody.append(row);
      row.addEventListener("pointerenter", () => highlight(item.run.id)); row.addEventListener("pointerleave", () => highlight(null));
      return {item, row, label, step, value};
    });
    function show(point) {
      if (pinned || !plot.range) return;
      lastPoint = point; clearTimeout(hideTimer); interactions.add(id);
      const x = plot.range.xmin + (point.x - box.left) / (box.right - box.left) * (plot.range.xmax - plot.range.xmin);
      dots.replaceChildren();
      for (const cell of cells) {
        const p = nearest(cell.item.points, x);
        cell.step.textContent = p ? format(p.step) : "—";
        cell.value.textContent = p ? format(p.y) : "—";
        cell.value.title = p ? `${options.axisLabel}: ${format(p.x)} · 原始值: ${format(p.raw)}${options.smoothing ? ` · 平滑值: ${format(p.y)}` : ""}` : "当前横轴下无记录";
        if (p && Number.isFinite(p.y) && p.x >= plot.range.xmin && p.x <= plot.range.xmax && p.y >= plot.range.ymin && p.y <= plot.range.ymax) dots.append(svgElement("circle", {cx: plot.px(p.x), cy: plot.py(p.y), r: 3.5, fill: style(cell.item.run).color, stroke: "#fff", "stroke-width": 1}));
      }
      marker.setAttribute("x1", point.x); marker.setAttribute("x2", point.x); marker.setAttribute("visibility", "visible");
      tooltip.hidden = false; position(point);
    }
    function cancelDrag() {
      if (!drag) return;
      const pointerId = drag.pointerId; drag = null;
      if (hit.hasPointerCapture(pointerId)) hit.releasePointerCapture(pointerId);
      brush.setAttribute("visibility", "hidden"); endInteraction(id);
    }
    function paint() {
      const focused = plot && document.activeElement === plot.svg;
      plot = makePlot(entry.metric, series, options, views.get(key));
      wrap.replaceChildren(plot.svg, tooltip);
      reset.disabled = !views.has(key);
      hint.textContent = views.has(key) ? "已放大 · 可再次右键框选 · 双击或点击“还原”恢复" : "右键拖框放大 · 双击还原 · 点击固定数据浮窗";
      plot.svg.setAttribute("tabindex", "0");
      if (focused) plot.svg.focus({preventScroll: true});
      plot.svg.addEventListener("contextmenu", event => event.preventDefault());
      plot.svg.addEventListener("dblclick", () => { pinned = false; tooltip.hidden = true; views.delete(key); paint(); endInteraction(id); });
      if (!plot.range) return;
      marker = svgElement("line", {y1: box.top, y2: box.bottom, stroke: "#a5bbc5", "stroke-dasharray": "3 3", visibility: "hidden", "pointer-events": "none"});
      dots = svgElement("g", {"pointer-events": "none"});
      brush = svgElement("rect", {fill: "#16877920", stroke: "#168779", "stroke-dasharray": "4 3", visibility: "hidden", "pointer-events": "none"});
      hit = svgElement("rect", {x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, fill: "transparent", "data-chart-hit": entry.metric});
      hit.addEventListener("pointerdown", event => {
        if (event.button !== 2) return;
        event.preventDefault(); clearTimeout(hideTimer); pinned = false; pin.textContent = "固定"; tooltip.hidden = true;
        marker.setAttribute("visibility", "hidden"); dots.replaceChildren();
        const point = screenPoint(plot.svg, event);
        drag = {...point, pointerId: event.pointerId}; interactions.add(id);
        hit.setPointerCapture(event.pointerId); plot.svg.focus({preventScroll: true});
        brush.setAttribute("x", point.x); brush.setAttribute("y", point.y); brush.setAttribute("width", 0); brush.setAttribute("height", 0); brush.setAttribute("visibility", "visible");
      });
      hit.addEventListener("pointermove", event => {
        const point = screenPoint(plot.svg, event);
        if (!drag) { show(point); return; }
        brush.setAttribute("x", Math.min(drag.x, point.x)); brush.setAttribute("y", Math.min(drag.y, point.y));
        brush.setAttribute("width", Math.abs(drag.x - point.x)); brush.setAttribute("height", Math.abs(drag.y - point.y));
      });
      hit.addEventListener("pointerup", event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const range = selectionRange(plot.range, drag, screenPoint(plot.svg, event));
        const pointerId = drag.pointerId; drag = null;
        if (hit.hasPointerCapture(pointerId)) hit.releasePointerCapture(pointerId);
        if (range) views.set(key, range);
        tooltip.hidden = true; paint(); endInteraction(id);
      });
      hit.addEventListener("pointercancel", cancelDrag);
      hit.addEventListener("lostpointercapture", cancelDrag);
      hit.addEventListener("pointerleave", laterHide);
      hit.addEventListener("click", () => { if (!lastPoint || tooltip.hidden) return; pinned = !pinned; pin.textContent = pinned ? "取消固定" : "固定"; });
      plot.svg.append(marker, dots, brush, hit);
    }
    expand.addEventListener("click", () => {
      expanded = !expanded; tooltip.classList.toggle("expanded-names", expanded); expand.textContent = expanded ? "折叠名称" : "展开名称";
    });
    pin.addEventListener("click", () => { pinned = !pinned; pin.textContent = pinned ? "取消固定" : "固定"; });
    close.addEventListener("click", () => { pinned = false; hide(); });
    tooltip.addEventListener("pointerenter", () => { clearTimeout(hideTimer); interactions.add(id); });
    tooltip.addEventListener("pointerleave", laterHide);
    reset.addEventListener("click", () => { pinned = false; tooltip.hidden = true; views.delete(key); paint(); endInteraction(id); });
    closers.set(id, () => { pinned = false; pin.textContent = "固定"; cancelDrag(); hide(); });
    card.updateSeries = (nextEntry, nextOptions) => {
      Object.assign(entry, nextEntry); Object.assign(options, nextOptions);
      series = entry.getSeries();
      cells.forEach((cell, index) => {
        cell.item = series[index]; cell.label.textContent = cell.item.run.name;
        cell.label.title = `${cell.item.run.project} / ${cell.item.run.name} [${cell.item.run.id}]`;
      });
      paint();
    };
    liveCards.set(entry.metric, card);
    paint(); card.append(heading, wrap, hint);
    return card;
  }

  function render(container, entries, options) {
    if (options.force) { interactions.clear(); pendingRender = null; }
    if (interactions.size) { pendingRender = [container, entries, options]; return; }
    const shape = JSON.stringify([entries.map(entry => [entry.metric, entry.runIds || entry.getSeries().map(item => item.run.id)]), options.axis, options.smoothing]);
    if (!options.force && container === renderedContainer && shape === renderedShape) {
      const openGroups = new Set(groupNodes.filter(node => node.details.open).map(node => node.group));
      for (const entry of entries) if (openGroups.has(parts(entry.metric).group)) liveCards.get(entry.metric)?.updateSeries(entry, options);
      for (const node of groupNodes) node.updateEntries(entries, options);
      return;
    }
    for (const node of groupNodes) {
      if (node.details.open) collapsed.delete(node.group); else collapsed.add(node.group);
    }
    groupNodes = []; liveCards.clear(); interactionGroups.clear(); closers.clear();
    renderedContainer = container; renderedShape = shape;
    const nodes = [];
    const groups = new Map();
    for (const entry of entries) {
      const group = parts(entry.metric).group;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(entry);
    }
    const priority = group => ({train: 0, valid: 1, test: 2}[group] ?? (group === "其他指标" ? 100 : 10));
    for (const [group, children] of [...groups].sort((a, b) => priority(a[0]) - priority(b[0]) || a[0].localeCompare(b[0]))) {
      const details = element("details", "metric-group"); details.dataset.group = group;
      details.open = !collapsed.has(group);
      const summary = element("summary"), heading = element("span", "metric-group-heading");
      heading.append(element("strong", "", group), element("small", "", `${children.length} 个指标`));
      const actions = element("span", "metric-group-actions");
      actions.append(exportButton(children, options, group, "png", true), exportButton(children, options, group, "svg", true));
      summary.append(heading, actions);
      const grid = element("div", `charts metric-group-grid${children.length === 1 ? " single-metric" : ""}`);
      let mounted = false;
      let currentChildren = children, currentOptions = options;
      const mount = () => {
        if (!mounted) { for (const entry of currentChildren) grid.append(chart(entry, currentOptions)); mounted = true; }
        else for (const entry of currentChildren) liveCards.get(entry.metric)?.updateSeries(entry, currentOptions);
      };
      const toggle = () => {
        if (details.open) { collapsed.delete(group); mount(); }
        else {
          collapsed.add(group);
          for (const key of interactions) if (interactionGroups.get(key) === group) interactions.delete(key);
        }
        rememberGroups();
        if (!details.open) endInteraction("");
      };
      details.addEventListener("toggle", toggle);
      if (details.open) mount();
      details.append(summary, grid); nodes.push(details);
      groupNodes.push({details, toggle, group, updateEntries(next, opts) {
        const latest = new Map(next.map(entry => [entry.metric, entry]));
        for (const entry of children) Object.assign(entry, latest.get(entry.metric));
        Object.assign(options, opts); currentChildren = children; currentOptions = options;
      }});
    }
    container.replaceChildren(...nodes);
  }
  function expandAll(open) {
    const queued = pendingRender; pendingRender = null;
    for (const {details, toggle} of groupNodes) { details.open = open; toggle(); }
    if (queued) render(...queued);
  }
  function resetAll() {
    views.clear();
    if (pendingRender) return;
    // The caller re-renders with its latest data and controls.
  }
  return {render, expandAll, resetAll, parts, nearest, selectionRange, exportSVG};
})();
