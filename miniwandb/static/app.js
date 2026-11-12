"use strict";

const $ = id => document.getElementById(id);
const palette = ["#168779", "#e4973e", "#637bcb", "#d36c87", "#58a2c1", "#a185bb", "#8d9a43", "#bc7855"];
const statusNames = {running: "运行中", finished: "已完成", failed: "失败", imported: "已导入", interrupted: "未正常结束"};
const state = {runs: [], selected: new Set(), focused: null, data: new Map(), colors: new Map(), initial: true, trash: false, mutating: false, paramRules: []};
let loading = false;
let pending = false;
let purgePlan = null;
let paramRuleId = 0;
let paramOptionsSignature = "";
let comparisonSignature = "";
let runListSignature = "";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgElement(tag, attributes, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function color(id) {
  if (!state.colors.has(id)) state.colors.set(id, palette[state.colors.size] || `hsl(${(state.colors.size * 137.508) % 360}, 54%, 43%)`);
  return state.colors.get(id);
}

function format(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "number") return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  if (value === 0) return "0";
  if (Math.abs(value) < 0.001 || Math.abs(value) >= 100000) return value.toExponential(2);
  return Number(value.toPrecision(5)).toString();
}

function date(timestamp) { return new Date(timestamp * 1000).toLocaleString(); }

async function request(path, options = {}) {
  const {timeoutMs = 15000, ...fetchOptions} = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {...fetchOptions, cache: "no-store", signal: controller.signal});
    if (!response.ok) {
      let detail;
      try { detail = await response.json(); } catch (_) { /* Use HTTP status if the server returns no JSON. */ }
      throw new Error(detail && detail.error ? detail.error : `HTTP ${response.status}`);
    }
    return await response.json();
  } finally { clearTimeout(timeout); }
}

function trashQuery() { return state.trash ? "?trash=1" : ""; }

function post(path, body) {
  return request(path, {method: "POST", headers: {"Content-Type": "application/json", "X-MiniWandb-Request": "1"}, body: JSON.stringify(body), timeoutMs: 120000});
}

function updatePurgeConfirmation() {
  const errors = purgePlan && purgePlan.mode === "purge" && $("delete-sources").checked
    ? purgePlan.experiments.filter(entry => entry.source_error).map(entry => `${entry.name}：${entry.source_error}`) : [];
  $("purge-error").hidden = !errors.length;
  $("purge-error").textContent = errors.join("\n");
  $("purge-confirm").disabled = state.mutating || errors.length > 0;
}

async function openPurge(ids) {
  if (state.mutating || !ids.length || !state.trash) return;
  state.mutating = true;
  renderRuns(); renderDetails();
  try {
    const preview = await post("/api/runs/purge-preview", {ids});
    purgePlan = {mode: "purge", experiments: preview.experiments};
    $("purge-title").textContent = `永久删除 ${preview.experiments.length} 个实验`;
    $("purge-description").textContent = "将从本地永久删除这些实验的参数、指标曲线、最终评估、控制台日志和导入记录，删除后无法从回收站恢复。";
    $("purge-items").replaceChildren();
    for (const entry of preview.experiments) {
      const item = element("div", "purge-item");
      item.append(element("strong", "", entry.name), element("small", "", `${entry.project} / ${entry.id} · ${entry.metrics} 条指标 · ${entry.evaluations || 0} 份最终评估`));
      if (entry.output_characters) item.append(element("small", "", `控制台日志：${entry.output_characters.toLocaleString()} 字符`));
      if (entry.source) item.append(element("code", "", `原始来源（可选删除）：${entry.target || entry.source}${entry.source_exists ? "" : entry.source_error ? "" : "（已不存在）"}`));
      else item.append(element("small", "", "无外部来源文件，只删除 MiniWandb 本地记录"));
      $("purge-items").append(item);
    }
    $("source-option").hidden = !preview.experiments.some(entry => entry.source);
    $("source-help").hidden = $("source-option").hidden;
    $("delete-sources").checked = false;
    $("purge-confirm").textContent = "确认永久删除";
    $("purge-dialog").showModal();
  } catch (error) {
    $("error").hidden = false;
    $("error").textContent = `无法准备删除：${error.message}`;
  } finally {
    state.mutating = false;
    updatePurgeConfirmation(); renderRuns(); renderDetails();
  }
}

function openCompaction() {
  if (state.mutating) return;
  purgePlan = {mode: "compact"};
  $("purge-title").textContent = "回收本地记录占用的磁盘空间";
  $("purge-description").textContent = "永久删除后的空闲空间可通过此操作归还磁盘，不会删除其他实验。请先结束训练；整理期间不能写入新的训练指标，数据较多时可能需要等待。";
  $("purge-items").replaceChildren();
  $("source-option").hidden = true;
  $("source-help").hidden = true;
  $("delete-sources").checked = false;
  $("purge-confirm").textContent = "开始回收空间";
  updatePurgeConfirmation();
  $("purge-dialog").showModal();
}

async function confirmPurge() {
  if (!purgePlan || state.mutating || $("purge-confirm").disabled) return;
  const plan = purgePlan;
  state.mutating = true;
  $("purge-confirm").disabled = true;
  $("purge-cancel").disabled = true;
  $("delete-sources").disabled = true;
  $("purge-confirm").textContent = "正在处理…";
  renderRuns(); renderDetails();
  try {
    if (plan.mode === "compact") {
      const result = await post("/api/storage/compact", {confirm: true});
      const freed = Math.max(0, result.before_bytes - result.after_bytes) / (1024 * 1024);
      $("notice").textContent = `空间回收完成，释放约 ${freed.toFixed(2)} MB。`;
    } else {
      const ids = plan.experiments.map(entry => entry.id);
      const result = await post("/api/runs/purge", {ids, confirm: true, delete_sources: $("delete-sources").checked});
      for (const id of ids) { state.selected.delete(id); state.data.delete(id); }
      if (ids.includes(state.focused)) state.focused = null;
      state.runs = state.runs.filter(run => !ids.includes(run.id));
      $("notice").textContent = `已永久删除 ${result.deleted} 个实验、${result.metrics} 条指标${result.source_paths.length ? `，并删除 ${result.source_paths.length} 个原始日志目录 / 文件` : ""}。需要缩小本地记录文件时，可在训练结束后点击“回收磁盘空间”。`;
    }
    $("notice").hidden = false;
    $("purge-dialog").close();
    renderRuns(); renderCharts(); renderDetails();
    await refresh();
  } catch (error) {
    $("purge-error").hidden = false;
    $("purge-error").textContent = `处理失败：${error.message}`;
  } finally {
    state.mutating = false;
    $("purge-cancel").disabled = false;
    $("delete-sources").disabled = false;
    $("purge-confirm").disabled = false;
    $("purge-confirm").textContent = plan.mode === "compact" ? "开始回收空间" : "确认永久删除";
    renderRuns(); renderDetails();
  }
}

async function changeRuns(ids, restore) {
  if (state.mutating || !ids.length) return;
  state.mutating = true;
  renderRuns(); renderDetails();
  try {
    const result = await request(`/api/runs/${restore ? "restore" : "trash"}`, {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-MiniWandb-Request": "1"},
      body: JSON.stringify({ids}),
    });
    for (const id of ids) { state.selected.delete(id); state.data.delete(id); }
    if (ids.includes(state.focused)) state.focused = null;
    state.runs = state.runs.filter(run => !ids.includes(run.id));
    $("notice").hidden = false;
    $("notice").textContent = restore ? `已恢复 ${result.updated} 个实验，可在“实验记录”中查看。` : `已将 ${result.updated} 个实验移入回收站。左侧切换“回收站”可恢复。`;
    renderRuns(); renderCharts(); renderDetails();
    await refresh();
  } catch (error) {
    $("error").hidden = false;
    $("error").textContent = `操作失败：${error.message}`;
  } finally {
    state.mutating = false;
    renderRuns(); renderDetails();
  }
}

function visibleRuns() {
  const groups = $("search").value.toLowerCase().split(/[,，\n]+/).map(q => q.trim()).filter(Boolean);
  return state.runs.filter(run => {
    if ($("project").value && run.project !== $("project").value) return false;
    if ($("status-filter").value && run.status !== $("status-filter").value) return false;
    if (!MiniParams.matches(run.config, state.paramRules, $("param-match").value || "all")) return false;
    const text = `${run.name} ${run.id} ${run.project} ${run.notes} ${run.tags.join(" ")}`.toLowerCase();
    return !groups.length || groups.some(group => group.split(/\s+/).every(word => text.includes(word)));
  });
}

function renderParamOptions() {
  const keys = [...new Set(state.runs.flatMap(run => [...MiniParams.flatten(run.config).keys()]))].sort();
  const signature = JSON.stringify(keys);
  if (signature === paramOptionsSignature) return;
  paramOptionsSignature = signature;
  $("param-key-options").replaceChildren();
  for (const key of keys) { const option = element("option"); option.value = key; $("param-key-options").append(option); }
}

function renderParamConditions() {
  $("param-conditions").replaceChildren();
  for (const rule of state.paramRules) {
    const row = element("div", "param-condition"); row.dataset.ruleId = rule.id;
    const key = element("input", "param-key"); key.type = "search"; key.value = rule.key;
    key.placeholder = "选择或输入参数名"; key.setAttribute("list", "param-key-options"); key.setAttribute("aria-label", "超参数名称");
    const controls = element("div", "param-condition-controls");
    const op = element("select"); op.setAttribute("aria-label", "超参数筛选运算符");
    for (const [value, label] of MiniParams.operators) { const option = element("option", "", label); option.value = value; op.append(option); }
    op.value = rule.op;
    const value = element("input"); value.type = "text"; value.value = rule.value; value.placeholder = "值，如 1e-4"; value.setAttribute("aria-label", "超参数筛选值");
    const remove = element("button", "remove-param-filter", "×"); remove.setAttribute("aria-label", "移除这条超参数条件");
    const hint = element("small", "param-condition-hint");
    const update = () => {
      rule.key = key.value; rule.op = op.value; rule.value = value.value;
      value.disabled = MiniParams.unary(rule.op);
      const invalid = MiniParams.invalid(rule);
      row.classList.toggle("invalid-condition", invalid);
      hint.textContent = invalid ? "请输入有效数字，支持 1e-4" : rule.key && !MiniParams.active(rule) ? "填写值后生效；空字符串请输入两个引号" : "";
      renderRuns();
    };
    key.addEventListener("input", update); op.addEventListener("change", update); value.addEventListener("input", update);
    remove.addEventListener("click", () => { state.paramRules = state.paramRules.filter(item => item.id !== rule.id); renderParamConditions(); renderRuns(); });
    value.disabled = MiniParams.unary(rule.op);
    if (MiniParams.invalid(rule)) { row.classList.toggle("invalid-condition", true); hint.textContent = "请输入有效数字，支持 1e-4"; }
    controls.append(op, value, remove); row.append(key, controls, hint); $("param-conditions").append(row);
  }
}

function addParamRule() {
  state.paramRules.push({id: ++paramRuleId, key: "", op: "eq", value: ""});
  renderParamConditions(); renderRuns();
  const rows = $("param-conditions").children;
  if (rows.length) rows[rows.length - 1].firstElementChild.focus();
}

function selectedMetadata() {
  const metadata = new Map(state.runs.map(run => [run.id, run]));
  return [...state.selected].map(id => metadata.get(id) || state.data.get(id)?.run).filter(Boolean);
}

function renderComparison() {
  const runs = MiniCV.parameterRuns(selectedMetadata());
  $("config-comparison").hidden = !runs.length;
  if (!runs.length) { comparisonSignature = ""; return; }
  $("config-only-diff").disabled = runs.length < 2;
  const options = {query: $("config-key-search").value.trim(), onlyDifferences: $("config-only-diff").checked};
  const signature = JSON.stringify([runs.map(run => [run.id, run.name, run.project, run.status, run.config, run.comparisonValues]), options]);
  if (signature === comparisonSignature) return;
  comparisonSignature = signature;
  const result = MiniParams.render($("comparison-table"), runs, options);
  $("comparison-count").textContent = `${runs.length} ${$("comparison-layout").value === "groups" ? "列（CV组/独立实验）" : "个实验"} · ${result.differences} 项差异 · 显示 ${result.rows.length} / ${result.total} 个参数`;
}

function selectRuns(action, checked=true) {
  state.initial = false;
  const visible = visibleRuns().map(run => run.id);
  if (action === "filtered") state.selected = new Set(visible);
  else if (action === "all") state.selected = new Set(state.runs.map(run => run.id));
  else if (action === "clear") state.selected.clear();
  else for (const id of visible) {
    const select = action === "invert" ? !state.selected.has(id) : checked;
    if (select) state.selected.add(id);
    else state.selected.delete(id);
  }
  if (!state.selected.has(state.focused)) state.focused = state.selected.values().next().value || null;
  renderRuns(); renderCharts(); renderDetails(); refresh();
}

function renderRuns() {
  const container = $("runs");
  const scrollTop = container.scrollTop;
  const focusedCheckbox = document.activeElement && document.activeElement.dataset.runId;
  const visible = visibleRuns();
  const filterCount = Number(!!$("project").value) + Number(!!$("status-filter").value) + Number(!!$("search").value.trim()) + state.paramRules.filter(MiniParams.active).length;
  $("filter-count").textContent = filterCount ? `${filterCount} 条条件 · ${visible.length}/${state.runs.length}` : "未启用";
  $("filter-panel").dataset.active = String(filterCount > 0);
  const listSignature = JSON.stringify([state.runs.map(run => [run.id, run.name, run.project, run.status, run.created_at, run.cv, run.config?.seed]),
    visible.map(run => run.id), [...state.selected], state.focused, state.trash, state.mutating, $("run-layout").value]);
  if (runListSignature !== listSignature) {
    runListSignature = listSignature;
    const host = element("div");
    let restoreFocus = null;
    const cvTargets = MiniCV.targets(host, visible, state.runs);
    if (!visible.length) host.append(element("p", "", "暂无符合条件的实验"));
    for (const run of visible) {
      const row = element("div", `run-row${state.selected.has(run.id) ? " selected" : ""}${state.focused === run.id ? " focused" : ""}`);
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.dataset.runId = run.id;
      if (run.id === focusedCheckbox) restoreFocus = checkbox;
      checkbox.checked = state.selected.has(run.id);
      checkbox.setAttribute("aria-label", `对比 ${run.name}`);
      checkbox.addEventListener("change", () => {
        state.initial = false;
        if (checkbox.checked) { state.selected.add(run.id); state.focused = run.id; }
        else state.selected.delete(run.id);
        renderRuns(); renderCharts(); renderDetails(); refresh();
      });
      const body = element("div", "run-body");
      const name = element("button", "run-name", run.name);
      name.title = `${run.name}\n${run.id}\n${date(run.created_at)}`;
      name.addEventListener("click", () => {
        state.focused = run.id;
        state.selected.add(run.id);
        state.initial = false;
        renderRuns(); renderCharts(); renderDetails(); refresh();
      });
      const meta = element("div", "run-meta");
      meta.append(element("span", `badge ${run.status}`, statusNames[run.status] || run.status), element("span", "run-project", run.project));
      meta.title = `${statusNames[run.status] || run.status} · ${run.project}${run.cv ? ` · fold ${run.cv.fold}` : ""}`;
      if (run.cv) meta.append(element("span", "run-fold", `fold ${run.cv.fold}`));
      body.append(name, meta);
      const checkTarget = element("label", "run-check");
      checkTarget.title = `勾选 ${run.name}`;
      checkTarget.append(checkbox);
      const detail = element("a", "run-detail-link", "↗");
      detail.href = `/runs/${encodeURIComponent(run.id)}${trashQuery()}`;
      detail.title = `打开 ${run.name} 的单次训练详情`;
      detail.setAttribute("aria-label", `打开 ${run.name} 的单次训练详情`);
      row.append(checkTarget, body, detail);
      (cvTargets.get(run.id) || host).append(row);
    }
    container.replaceChildren(...Array.from(host.children));
    container.scrollTop = scrollTop;
    if (restoreFocus) restoreFocus.focus({preventScroll: true});
  }
  const selectedVisible = visible.filter(run => state.selected.has(run.id)).length;
  const hiddenSelected = state.selected.size - selectedVisible;
  $("select-visible").checked = visible.length > 0 && selectedVisible === visible.length;
  $("select-visible").indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  $("select-visible").disabled = !visible.length;
  $("visible-selection-label").textContent = `筛选结果已选 ${selectedVisible} / ${visible.length}`;
  $("selection-summary").textContent = `已选 ${state.selected.size} / ${state.runs.length} 个实验${hiddenSelected ? ` · ${hiddenSelected} 个在筛选外` : ""}`;
  $("selection-summary").title = $("selection-summary").textContent;
  $("batch-selection-count").textContent = `${state.selected.size} 已选`;
  $("select-filtered").disabled = !visible.length;
  $("invert-selection").disabled = !visible.length;
  $("select-all").disabled = !state.runs.length;
  $("clear").disabled = !state.selected.size;
  $("run-count").textContent = state.runs.length;
  $("total-label").textContent = state.trash ? "回收站记录" : "全部实验";
  $("total").textContent = state.runs.length;
  $("running").textContent = state.runs.filter(r => r.status === "running").length;
  $("finished").textContent = state.runs.filter(r => r.status === "finished").length;
  $("batch-action").textContent = `${state.trash ? "恢复选中实验" : "移入回收站"}${state.selected.size ? `（${state.selected.size}）` : ""}`;
  $("batch-action").disabled = !state.selected.size || state.mutating;
  $("purge-tools").hidden = !state.trash;
  $("purge-selected").textContent = `永久删除选中实验${state.selected.size ? `（${state.selected.size}）` : ""}`;
  $("purge-selected").disabled = !state.selected.size || state.mutating;
  $("empty-trash").textContent = `清空回收站（${state.runs.length}）`;
  $("empty-trash").disabled = !state.runs.length || state.mutating;
  $("compact-storage").disabled = state.mutating;
  $("cv-manual-group").disabled = !state.selected.size || state.mutating;
  $("cv-auto-group").disabled = !visible.some(run => !run.cv) || state.mutating;
  MiniReports.update();
}

function seriesFor(data, metric) {
  const result = [];
  let epoch = null, average = null;
  const weight = Number($("smoothing").value) / 100;
  for (const row of data.history) {
    if (Number.isFinite(row.metrics.epoch)) epoch = row.metrics.epoch;
    if (!Object.prototype.hasOwnProperty.call(row.metrics, metric)) continue;
    const axis = $("x-axis").value;
    const x = axis === "time" ? row.timestamp - data.run.created_at : axis === "epoch" ? epoch : row.step;
    if (!Number.isFinite(x)) continue;
    const raw = row.metrics[metric];
    if (Number.isFinite(raw)) average = average === null ? raw : weight * average + (1 - weight) * raw;
    else average = null;
    result.push({x, y: average, raw, step: row.step});
  }
  return result.sort((a, b) => a.x - b.x || a.step - b.step);
}

// Preserve each bucket's extrema and null gaps, without huge SVG path strings.
function reducePoints(points) {
  if (points.length <= 1200) return points;
  const output = [];
  const size = Math.ceil(points.length / 300);
  for (let start = 0; start < points.length; start += size) {
    const end = Math.min(start + size, points.length);
    let low = start, high = start;
    const keep = new Set([start, end - 1]);
    for (let i = start; i < end; i++) {
      if (points[i].y === null) {
        // Keep gap boundaries so downsampling cannot join separate segments.
        if (i === start || points[i - 1].y !== null) { keep.add(i); if (i > start) keep.add(i - 1); }
        if (i === end - 1 || points[i + 1].y !== null) { keep.add(i); if (i + 1 < end) keep.add(i + 1); }
      } else {
        if (points[low].y === null || points[i].y < points[low].y) low = i;
        if (points[high].y === null || points[i].y > points[high].y) high = i;
      }
    }
    keep.add(low); keep.add(high);
    for (const index of [...keep].sort((a, b) => a - b)) output.push(points[index]);
  }
  return output;
}

function renderCharts(force = true) {
  $("selected-count").textContent = state.selected.size;
  $("selection-label").textContent = state.selected.size ? `正在对比 ${state.selected.size} 个实验 · 按指标组查看、缩放和导出` : "选择实验，查看训练过程";
  const selected = [...state.selected].map(id => state.data.get(id)).filter(Boolean);
  const filter = $("metric-search").value.toLowerCase();
  const keys = [...new Set(selected.flatMap(data => data.metrics))].sort().filter(key => key.toLowerCase().includes(filter));
  $("legend").replaceChildren();
  for (const data of selected) {
    const item = element("span", "legend-item");
    const dot = element("span", "legend-dot");
    dot.style.backgroundColor = color(data.run.id);
    item.title = `${data.run.project} / ${data.run.name} [${data.run.id}]`;
    item.append(dot, element("span", "legend-label", data.run.name));
    $("legend").append(item);
  }
  const entries = keys.map(metric => {
    let cached;
    return {metric, runIds: selected.filter(d => d.metrics.includes(metric)).map(d => d.run.id), getSeries: () => {
      if (!cached) cached = selected.filter(d => d.metrics.includes(metric)).map(data => ({run: data.run, points: seriesFor(data, metric)}));
      return cached;
    }};
  });
  MiniCharts.render($("charts"), entries, {axis: $("x-axis").value,
    axisLabel: $("x-axis").selectedOptions[0].textContent, smoothing: Number($("smoothing").value), force,
    onError: error => { $("error").hidden = false; $("error").textContent = `图片导出失败：${error.message}`; }});
  $("empty").hidden = keys.length > 0;
  if (!keys.length) {
    $("empty").querySelector("h3").textContent = filter ? "没有匹配的指标" : state.selected.size ? "等待第一条指标" : state.trash ? "回收站中没有选中的实验" : "从一条曲线开始";
  }
}

function detailTable(title, values) {
  const section = element("div", "detail-table");
  section.append(element("h4", "", title));
  const table = element("table");
  for (const [key, value] of Object.entries(values)) {
    const row = element("tr");
    row.append(element("td", "", key), element("td", "", format(value)));
    table.append(row);
  }
  if (!Object.keys(values).length) section.append(element("p", "", "暂无记录"));
  section.append(table);
  return section;
}

function renderDetails() {
  renderComparison();
  MiniCV.update();
  MiniEvaluations.update();
  const data = state.data.get(state.focused);
  $("details").hidden = !data;
  if (!data) return;
  const run = data.run;
  const panel = element("div", "detail-panel");
  const top = element("div", "detail-top");
  top.append(element("h3", "", run.name), element("p", "", run.notes || "无备注"),
    element("small", "", `${run.project} / ${run.id} · ${statusNames[run.status] || run.status} · 创建于 ${date(run.created_at)}${run.finished_at ? ` · 结束于 ${date(run.finished_at)}` : ""}`));
  if (run.tags.length) top.append(element("small", "", run.tags.map(t => `#${t}`).join(" ")));
  if (run.trashed_at) top.append(element("small", "", `移入回收站于 ${date(run.trashed_at)}`));
  if (run.cv) {
    const cvInfo = element("small", "", `CV组：${run.cv.name} · fold ${run.cv.fold} / ${run.cv.n_splits} 折`);
    top.append(cvInfo);
    const detach = element("button", "text-button", "解除此记录的分组");
    detach.disabled = state.mutating;
    detach.addEventListener("click", async () => {
      try { await post("/api/cv/detach", {ids: [run.id], confirm: true}); await refresh(); }
      catch (problem) { $("error").hidden = false; $("error").textContent = problem.message; }
    });
    top.append(detach);
  }
  const tables = element("div", "detail-tables single-detail-table");
  tables.append(detailTable("SUMMARY / 最新指标", run.summary));
  panel.append(top, tables);
  $("detail-content").replaceChildren(panel);
  $("exports").replaceChildren();
  const detailLink = element("a", "", "单次训练详情 ↗");
  detailLink.href = `/runs/${encodeURIComponent(run.id)}${trashQuery()}`;
  $("exports").append(detailLink);
  for (const type of ["csv", "json"]) {
    const link = element("a", "", `导出 ${type.toUpperCase()}`);
    link.href = `/api/runs/${encodeURIComponent(run.id)}/export.${type}${trashQuery()}`;
    link.download = `experiment.${type}`;
    $("exports").append(link);
  }
  const action = element("button", state.trash ? "" : "danger-button", state.trash ? "恢复实验" : "移入回收站");
  action.disabled = state.mutating;
  action.addEventListener("click", () => changeRuns([run.id], state.trash));
  $("exports").append(action);
  if (state.trash) {
    const permanent = element("button", "danger-button", "永久删除");
    permanent.disabled = state.mutating;
    permanent.addEventListener("click", () => openPurge([run.id]));
    $("exports").append(permanent);
  }
}

async function refresh() {
  if (loading) { pending = true; return; }
  loading = true;
  const mode = state.trash;
  const previousSelection = JSON.stringify([...state.selected]);
  $("refresh").textContent = "刷新中…";
  try {
    const payload = await request(`/api/runs${mode ? "?trash=1" : ""}`);
    if (mode !== state.trash) return;
    state.runs = payload.runs;
    renderParamOptions();
    const projects = [...new Set(state.runs.map(r => r.project))].sort();
    const previous = $("project").value;
    const projectSignature = JSON.stringify(projects);
    if ($("project").dataset.options !== projectSignature) {
      const all = element("option", "", "全部项目"); all.value = "";
      const options = projects.map(name => { const option = element("option", "", name); option.value = name; return option; });
      $("project").replaceChildren(all, ...options); $("project").dataset.options = projectSignature;
    }
    $("project").value = projects.includes(previous) ? previous : "";
    const ids = new Set(state.runs.map(r => r.id));
    for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
    for (const id of state.data.keys()) if (!ids.has(id) || (!state.selected.has(id) && id !== state.focused)) state.data.delete(id);
    if (state.initial && visibleRuns().length) {
      const first = visibleRuns()[0].id;
      state.selected.add(first); state.focused = first; state.initial = false;
    }
    const toLoad = new Set(state.selected);
    if (state.focused && ids.has(state.focused)) toLoad.add(state.focused);
    if (!ids.has(state.focused)) state.focused = null;
    const metadata = new Map(state.runs.map(run => [run.id, run]));
    const queue = [...toLoad];
    const results = [];
    // Batch selection must not launch an unbounded number of history requests.
    await Promise.all(Array.from({length: Math.min(4, queue.length)}, async () => {
      while (queue.length && mode === state.trash) {
        const id = queue.shift();
        if (!state.selected.has(id) && state.focused !== id) continue;
        const cached = state.data.get(id);
        if (cached && JSON.stringify(cached.run) === JSON.stringify(metadata.get(id))) continue;
        if (cached && cached.run.updated_at === metadata.get(id).updated_at && cached.run.last_step === metadata.get(id).last_step) {
          results.push([id, {...cached, run: metadata.get(id)}]); continue;
        }
        results.push([id, await request(`/api/runs/${encodeURIComponent(id)}${mode ? "?trash=1" : ""}`)]);
      }
    }));
    if (mode !== state.trash) return;
    for (const [id, data] of results) state.data.set(id, data);
    renderRuns();
    if (results.length || previousSelection !== JSON.stringify([...state.selected])) renderCharts(false);
    renderDetails();
    $("error").hidden = true;
    $("updated").textContent = `更新于 ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    $("error").hidden = false;
    $("error").textContent = `读取实验失败：${error.message}。请确认本地服务正在运行，稍后点击刷新。`;
  } finally {
    loading = false;
    $("refresh").textContent = "刷新";
    if (pending) { pending = false; refresh(); }
  }
}

$("refresh").addEventListener("click", refresh);
$("view").addEventListener("change", () => {
  state.trash = $("view").value === "trash";
  state.selected.clear(); state.focused = null; state.data.clear(); state.runs = []; state.initial = true;
  $("project").value = "";
  renderRuns(); renderCharts(); renderDetails(); refresh();
});
$("batch-action").addEventListener("click", () => changeRuns([...state.selected], state.trash));
$("purge-selected").addEventListener("click", () => openPurge([...state.selected]));
$("empty-trash").addEventListener("click", () => openPurge(state.runs.map(run => run.id)));
$("compact-storage").addEventListener("click", openCompaction);
$("delete-sources").addEventListener("change", updatePurgeConfirmation);
$("purge-confirm").addEventListener("click", confirmPurge);
$("purge-cancel").addEventListener("click", () => { if (!state.mutating) $("purge-dialog").close(); });
$("purge-dialog").addEventListener("close", () => { purgePlan = null; });
$("purge-dialog").addEventListener("cancel", event => { if (state.mutating) event.preventDefault(); });
$("select-visible").addEventListener("change", () => selectRuns("visible", $("select-visible").checked));
$("select-filtered").addEventListener("click", () => selectRuns("filtered"));
$("invert-selection").addEventListener("click", () => selectRuns("invert"));
$("select-all").addEventListener("click", () => selectRuns("all"));
$("search").addEventListener("input", renderRuns);
$("project").addEventListener("change", renderRuns);
$("status-filter").addEventListener("change", renderRuns);
$("add-param-filter").addEventListener("click", addParamRule);
$("param-match").addEventListener("change", renderRuns);
$("reset-filters").addEventListener("click", () => {
  $("project").value = ""; $("status-filter").value = ""; $("search").value = ""; $("param-match").value = "all";
  state.paramRules = []; renderParamConditions(); renderRuns();
});
$("config-key-search").addEventListener("input", renderComparison);
$("config-only-diff").addEventListener("change", renderComparison);
$("clear").addEventListener("click", () => selectRuns("clear"));
$("metric-search").addEventListener("input", renderCharts);
$("expand-groups").addEventListener("click", () => MiniCharts.expandAll(true));
$("collapse-groups").addEventListener("click", () => MiniCharts.expandAll(false));
$("reset-chart-views").addEventListener("click", () => { MiniCharts.resetAll(); renderCharts(); });
$("x-axis").addEventListener("change", renderCharts);
$("smoothing").addEventListener("input", () => { $("smooth-value").textContent = $("smoothing").value; renderCharts(); });
setInterval(() => { if ($("auto").checked && !document.hidden && !loading) refresh(); }, 3000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && $("auto").checked) refresh(); });
MiniCV.init();
MiniEvaluations.init();
MiniReports.init({getIds: () => [...state.selected], getTrash: () => state.trash, getPrimaryMetric: () => MiniCV.analysisMetric()});
refresh();
