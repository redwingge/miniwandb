"use strict";

const $ = id => document.getElementById(id);
const statusNames = {running: "运行中", finished: "已完成", failed: "失败", imported: "已导入", interrupted: "未正常结束"};
const runId = decodeURIComponent(location.pathname.split("/")[2] || "");
const trash = new URLSearchParams(location.search).get("trash") === "1";
const api = `/api/runs/${encodeURIComponent(runId)}`;
let data = null, loading = false, logLoading = false, cursor = null, logText = "", clipped = false, available = false;
let chartSignature = "", parameterSignature = "", evaluationSignature = "", summarySignature = "";
const maxLogCharacters = 262144;
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function svgElement(tag, attributes, text) { const node = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); if (text !== undefined) node.textContent = text; return node; }
function color() { return "#168779"; }
function format(value) { if (value == null) return "—"; if (typeof value !== "number") return typeof value === "object" ? JSON.stringify(value) : String(value); if (!value) return "0"; return Math.abs(value) < 0.001 || Math.abs(value) >= 100000 ? value.toExponential(2) : Number(value.toPrecision(5)).toString(); }
function date(value) { return new Date(value * 1000).toLocaleString(); }
function url(path, extra = {}) { const query = new URLSearchParams(extra); if (trash) query.set("trash", "1"); return api + path + (query.size ? "?" + query : ""); }
async function request(path) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
  try { const response = await fetch(path, {cache: "no-store", signal: controller.signal}); if (!response.ok) { const error = await response.json(); throw new Error(error.error || `HTTP ${response.status}`); } return await response.json(); }
  finally { clearTimeout(timeout); }
}
function error(problem) { $("error").hidden = false; $("error").textContent = `无法读取实验：${problem.message}`; }
function values(container, metrics) {
  const previous = new Map(Array.from(container.children).filter(node => node.dataset.valueKey).map(node => [node.dataset.valueKey, node]));
  const nodes = [];
  for (const [key, value] of Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b))) {
    let item = previous.get(key);
    if (!item) { item = element("div", "run-value"); item.dataset.valueKey = key; item.append(element("span", "", key), element("strong")); }
    const text = format(value);
    if (item.children[1].textContent !== text) item.children[1].textContent = text;
    item.title = `${key}: ${JSON.stringify(value)}`; nodes.push(item);
  }
  if (!nodes.length) nodes.push(previous.size ? element("p", "run-empty", "暂无记录") : container.children[0] || element("p", "run-empty", "暂无记录"));
  if (nodes.length !== container.children.length || nodes.some((node, i) => node !== container.children[i])) container.replaceChildren(...nodes);
}
function metadata() {
  const run = data.run;
  document.title = `${run.name} · MiniWandb`;
  $("run-project").textContent = run.project;
  $("run-title").textContent = run.name;
  $("run-identity").textContent = `${run.id}${run.trashed_at ? " · 回收站中的实验" : ""}`;
  $("run-status").textContent = statusNames[run.status] || run.status;
  $("run-step").textContent = run.last_step >= 0 ? run.last_step : "—";
  $("run-metric-count").textContent = data.metrics.length;
  const seconds = Math.max(0, Math.floor((run.finished_at || (run.status === "running" ? Date.now() / 1000 : run.updated_at)) - run.created_at));
  $("run-duration").textContent = seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  $("run-times").textContent = `创建：${date(run.created_at)} · 最后更新：${date(run.updated_at)}${run.finished_at ? ` · 结束：${date(run.finished_at)}` : ""}`;
  $("run-notes").textContent = run.notes || "无备注";
  $("run-tags").textContent = run.tags.map(tag => `#${tag}`).join("  ");
  $("run-cv").textContent = run.cv ? `CV 组：${run.cv.name} · fold ${run.cv.fold} / ${run.cv.n_splits} 折 · ${run.cv.group_id}${run.cv.preferred ? " · 手动指定用于统计" : ""}` : "独立实验 · 尚未归入 CV 组";
  const signature = JSON.stringify(run.summary);
  if (signature !== summarySignature) { summarySignature = signature; values($("run-summary-values"), run.summary); }
  parameters(); evaluations();
  MiniReports.update();
}
function parameters() {
  if (!data) return;
  const query = $("config-search").value, signature = JSON.stringify([data.run.config, query]);
  if (signature === parameterSignature) return; parameterSignature = signature;
  MiniParams.render($("run-parameters"), [data.run], {query, onlyDifferences: false});
}
function evaluations() {
  const records = data.evaluations || [], signature = JSON.stringify(records);
  if (signature === evaluationSignature) return; evaluationSignature = signature;
  const container = $("run-evaluations"), previous = new Map(Array.from(container.children).map(node => [node.dataset.evaluation, node.open]));
  const nodes = [];
  if (!records.length) { container.replaceChildren(element("p", "run-empty", "尚未保存最终评估；训练结束评估后使用 log_evaluation() 记录。")); return; }
  for (const record of records) {
    const card = element("details", "run-evaluation"); card.dataset.evaluation = JSON.stringify([record.dataset, record.name]);
    card.open = previous.get(card.dataset.evaluation) ?? true;
    card.append(element("summary", "", `${record.dataset} / ${record.name}`));
    const metrics = element("div", "run-evaluation-values"); values(metrics, record.metrics); card.append(metrics);
    if (Object.keys(record.metadata).length) { const meta = element("details", "run-evaluation-metadata"); meta.append(element("summary", "", "评估元数据"), element("pre", "", JSON.stringify(record.metadata, null, 2))); card.append(meta); }
    nodes.push(card);
  }
  container.replaceChildren(...nodes);
}
function seriesFor(metric) {
  let epoch = null, average = null; const weight = Number($("smoothing").value) / 100, axis = $("x-axis").value, points = [];
  for (const row of data.history) {
    if (Number.isFinite(row.metrics.epoch)) epoch = row.metrics.epoch;
    if (!Object.prototype.hasOwnProperty.call(row.metrics, metric)) continue;
    const x = axis === "time" ? row.timestamp - data.run.created_at : axis === "epoch" ? epoch : row.step;
    if (!Number.isFinite(x)) continue;
    const raw = row.metrics[metric]; average = Number.isFinite(raw) ? average === null ? raw : weight * average + (1 - weight) * raw : null;
    points.push({x, y: average, raw, step: row.step});
  }
  return points.sort((a, b) => a.x - b.x || a.step - b.step);
}
function reducePoints(points) {
  if (points.length <= 1200) return points;
  const result = [], size = Math.ceil(points.length / 300);
  for (let start = 0; start < points.length; start += size) {
    const end = Math.min(start + size, points.length), keep = new Set([start, end - 1]); let low = start, high = start;
    for (let i = start; i < end; i++) {
      if (points[i].y === null) { if (i === start || points[i - 1].y !== null) { keep.add(i); if (i > start) keep.add(i - 1); } if (i === end - 1 || points[i + 1].y !== null) { keep.add(i); if (i + 1 < end) keep.add(i + 1); } }
      else { if (points[low].y === null || points[i].y < points[low].y) low = i; if (points[high].y === null || points[i].y > points[high].y) high = i; }
    }
    keep.add(low); keep.add(high); for (const i of [...keep].sort((a, b) => a - b)) result.push(points[i]);
  }
  return result;
}
function charts(force = true) {
  if (!data) return;
  const search = $("metric-search").value.toLowerCase(), metrics = data.metrics.filter(metric => metric.toLowerCase().includes(search));
  const entries = metrics.map(metric => ({metric, runIds: [data.run.id], getSeries: () => [{run: data.run, points: seriesFor(metric)}]}));
  MiniCharts.render($("charts"), entries, {axis: $("x-axis").value, axisLabel: $("x-axis").selectedOptions[0].textContent,
    smoothing: Number($("smoothing").value), force, onError: error});
  $("curve-empty").hidden = !!metrics.length;
}
function displayOutput() {
  const pre = $("output-text"), top = pre.scrollTop;
  const clean = logText.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n").map(line => line.replace(/\r+$/, "").split("\r").pop()).join("\n");
  const search = $("output-search").value.toLowerCase();
  const shown = search ? clean.split("\n").filter(line => line.toLowerCase().includes(search)).join("\n") : clean;
  const page = typeof window === "undefined" ? null : {x: window.scrollX, y: window.scrollY};
  if (pre.textContent !== shown) {
    if (pre.textContent && shown.startsWith(pre.textContent)) pre.append(document.createTextNode(shown.slice(pre.textContent.length)));
    else pre.textContent = shown;
  }
  $("output-status").textContent = available ? `${clipped ? "当前为截取的最新日志" : "已加载日志"} · ${logText.length.toLocaleString()} 个字符${search ? " · 正在筛选" : ""}` : '尚无日志。新训练可设置 capture_output=True；已有文件可使用 attach_output() 补录。';
  pre.classList.toggle("wrap", $("output-wrap").checked);
  pre.scrollTop = $("output-follow").checked ? pre.scrollHeight : top;
  if (page && (window.scrollY !== page.y || window.scrollX !== page.x)) window.scrollTo({left: page.x, top: page.y, behavior: "instant"});
}
async function output(reset = false) {
  if (logLoading) return; logLoading = true;
  try {
    let next = reset ? null : cursor;
    for (let page = 0; page < 4; page++) {
      const payload = await request(url("/output", next === null ? {} : {after: String(next)}));
      if (!payload.available) { logText = ""; clipped = false; }
      else if (next === null || payload.reset) { logText = payload.text; clipped = payload.truncated; } else logText += payload.text;
      available = payload.available; cursor = next = payload.next;
      if (logText.length > maxLogCharacters) { logText = logText.slice(-maxLogCharacters); clipped = true; }
      if (!payload.has_more) break;
    }
    displayOutput(); $("output-error").hidden = true;
  } catch (problem) { $("output-error").hidden = false; $("output-error").textContent = `日志读取失败：${problem.message}`; }
  finally { logLoading = false; }
}
async function refresh() {
  if (loading) return; loading = true; $("refresh").disabled = true;
  try {
    const meta = await request(url("/metadata"));
    const signature = JSON.stringify([meta.run.updated_at, meta.run.last_step]);
    if (!data || chartSignature !== signature) { data = await request(url("")); chartSignature = JSON.stringify([data.run.updated_at, data.run.last_step]); charts(false); }
    else { data.run = meta.run; data.evaluations = meta.evaluations; }
    metadata(); $("error").hidden = true; $("updated").textContent = `更新于 ${new Date().toLocaleTimeString()}`;
    await output();
  } catch (problem) { error(problem); }
  finally { loading = false; $("refresh").disabled = false; }
}
for (const type of ["csv", "json"]) { const link = element("a", "", type.toUpperCase()); link.href = url(`/export.${type}`); $("run-downloads").append(link); }
$("output-download").href = url("/output.log");
$("refresh").addEventListener("click", refresh);
$("config-search").addEventListener("input", parameters);
$("metric-search").addEventListener("input", () => charts());
$("x-axis").addEventListener("change", () => charts());
$("smoothing").addEventListener("input", () => { $("smooth-value").textContent = $("smoothing").value; charts(); });
$("expand-groups").addEventListener("click", () => MiniCharts.expandAll(true));
$("collapse-groups").addEventListener("click", () => MiniCharts.expandAll(false));
$("reset-chart-views").addEventListener("click", () => { MiniCharts.resetAll(); charts(); });
$("output-reload").addEventListener("click", () => { $("output-follow").checked = true; output(true); });
$("output-wrap").addEventListener("change", displayOutput);
$("output-search").addEventListener("input", displayOutput);
$("output-follow").addEventListener("change", () => { if ($("output-follow").checked) $("output-text").scrollTop = $("output-text").scrollHeight; });
$("output-text").addEventListener("scroll", () => { const pre = $("output-text"); if (pre.scrollHeight - pre.clientHeight - pre.scrollTop > 40) $("output-follow").checked = false; });
setInterval(() => { if ($("auto").checked && !document.hidden) refresh(); }, 3000);
document.addEventListener("visibilitychange", () => { if ($("auto").checked && !document.hidden) refresh(); });
MiniReports.init({getIds: () => data ? [runId] : [], getTrash: () => trash});
refresh();
