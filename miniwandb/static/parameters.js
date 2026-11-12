"use strict";

const MiniParams = (() => {
  const cache = new WeakMap();
  const operators = [["eq", "等于"], ["ne", "不等于"], ["contains", "包含"],
    ["gt", ">"], ["ge", "≥"], ["lt", "<"], ["le", "≤"], ["exists", "已记录"], ["missing", "未记录"]];
  const unary = op => op === "exists" || op === "missing";
  const numeric = op => ["gt", "ge", "lt", "le"].includes(op);
  function keyLabel(path) {
    return path.map((key, index) => /^[A-Za-z_$][\w$-]*$/.test(key) ? (index ? "." : "") + key : `[${JSON.stringify(key)}]`).join("");
  }
  function flatten(config) {
    if (!config || typeof config !== "object") return new Map();
    if (cache.has(config)) return cache.get(config);
    const result = new Map();
    function visit(value, path) {
      if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
        for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
      } else if (path.length) result.set(keyLabel(path), value);
    }
    visit(config, []); cache.set(config, result); return result;
  }
  function canonical(value) {
    if (value && typeof value === "object") {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      return `{${Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",")}}`;
    }
    return JSON.stringify(value);
  }
  function display(value) { return value?.__miniwandb_cv_variation ? "组内差异" : canonical(value) ?? "未记录"; }
  function detail(value) {
    return value?.__miniwandb_cv_variation ? value.folds.map(cell => `fold ${cell.fold}: ${cell.present ? canonical(cell.value) : "未记录"}`).join("\n") : display(value);
  }
  function parse(value) {
    const text = String(value).trim();
    try { return JSON.parse(/^(true|false|null)$/i.test(text) ? text.toLowerCase() : text); }
    catch (_) { return text; }
  }
  function number(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
    const result = Number(value); return Number.isFinite(result) ? result : null;
  }
  function active(rule) { return !!rule.key.trim() && (unary(rule.op) || !!String(rule.value).trim()); }
  function invalid(rule) { return active(rule) && numeric(rule.op) && number(rule.value) === null; }
  function match(config, rule) {
    const values = flatten(config), key = rule.key.trim(), exists = values.has(key);
    if (rule.op === "exists") return exists;
    if (rule.op === "missing") return !exists;
    if (!exists || invalid(rule)) return false;
    const actual = values.get(key);
    if (numeric(rule.op)) {
      const left = number(actual), right = number(rule.value);
      if (left === null || right === null) return false;
      return {gt: () => left > right, ge: () => left >= right, lt: () => left < right, le: () => left <= right}[rule.op]();
    }
    if (rule.op === "contains") return String(typeof actual === "string" ? actual : display(actual)).toLowerCase().includes(String(rule.value).trim().toLowerCase());
    const equal = canonical(actual) === canonical(parse(rule.value));
    return rule.op === "ne" ? !equal : equal;
  }
  function matches(config, rules, mode = "all") {
    const enabled = rules.filter(active);
    if (enabled.some(invalid)) return false;
    return !enabled.length || (mode === "any" ? enabled.some(rule => match(config, rule)) : enabled.every(rule => match(config, rule)));
  }
  function rows(runs, query = "", onlyDifferences = false) {
    const values = runs.map(run => run.comparisonValues ? new Map(run.comparisonValues) : flatten(run.config));
    const keys = [...new Set(values.flatMap(map => [...map.keys()]))].sort((a, b) => a.localeCompare(b));
    const result = keys.map(key => {
      const cells = values.map(map => ({present: map.has(key), value: map.get(key)}));
      const different = new Set(cells.map(cell => cell.present ? "value:" + canonical(cell.value) : "missing")).size > 1;
      return {key, cells, different};
    });
    return {total: keys.length, differences: result.filter(row => row.different).length,
      rows: result.filter(row => row.key.toLowerCase().includes(query.toLowerCase()) && (!onlyDifferences || runs.length < 2 || row.different))};
  }
  function render(container, runs, options) {
    const comparison = rows(runs, options.query, options.onlyDifferences);
    const left = container.scrollLeft, top = container.scrollTop;
    container.replaceChildren();
    if (!comparison.rows.length) {
      container.append(element("p", "comparison-empty", comparison.total ? "当前条件下没有参数；可取消“仅显示差异”或清空参数搜索。" : "这些实验尚未记录参数。"));
      return comparison;
    }
    const table = element("table", "comparison-table");
    table.setAttribute("aria-label", "选中实验的超参数对比");
    const head = element("thead"), header = element("tr"), corner = element("th", "parameter-key", "超参数");
    corner.setAttribute("scope", "col"); header.append(corner);
    for (const run of runs) {
      const cell = element("th"); cell.setAttribute("scope", "col");
      const name = element("span", "comparison-run-name", run.name);
      name.style.color = color(run.id); name.title = run.name;
      cell.append(name, element("small", "", `${run.project} / ${run.id}`), element("small", "", statusNames[run.status] || run.status));
      header.append(cell);
    }
    head.append(header); table.append(head);
    const body = element("tbody");
    for (const row of comparison.rows) {
      const tr = element("tr", row.different ? "parameter-different" : "");
      const key = element("th", "parameter-key"); key.setAttribute("scope", "row");
      key.append(element("span", "", row.key));
      if (row.different) key.append(element("small", "difference-label", "不同"));
      tr.append(key);
      for (const cell of row.cells) {
        const td = element("td", cell.present ? cell.value?.__miniwandb_cv_variation ? "parameter-varied" : "" : "parameter-missing");
        const value = element("span", "parameter-value", cell.present ? display(cell.value) : "未记录");
        value.title = detail(cell.value); td.append(value); tr.append(td);
      }
      body.append(tr);
    }
    table.append(body); container.append(table); container.scrollLeft = left; container.scrollTop = top;
    return comparison;
  }
  return {operators, unary, flatten, canonical, display, active, invalid, match, matches, rows, render};
})();
