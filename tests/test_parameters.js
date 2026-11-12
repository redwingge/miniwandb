const assert = require("node:assert/strict");
const {dashboard, runs} = require("./test_selection");

const configs = [
  {lr: 0.0001, batch_size: 4, optimizer: {name: "adamw", decay: 0.01}, flags: false, optional: null, weights: [1, 2], "literal.key": 9},
  {lr: 0.00005, batch_size: 8, optimizer: {name: "adamw", decay: 0.01}, flags: true, weights: [1, 2]},
  {lr: "0.0001", batch_size: 16, optimizer: {name: "sgd", decay: 0.01}, flags: false, weights: [2, 1]},
];
function fixture() {
  const app = dashboard();
  const metadata = runs.slice(0, 3).map((run, i) => ({...run, config: configs[i]}));
  app.run(`state.runs=${JSON.stringify(metadata)};state.initial=false;state.selected=new Set(["a","b","c"]);renderParamOptions();renderRuns();renderComparison();`);
  return app;
}
function ids(app) { return app.value("visibleRuns().map(run=>run.id)"); }
function rules(app, values, mode = "all") {
  app.run(`state.paramRules=${JSON.stringify(values)};document.getElementById("param-match").value=${JSON.stringify(mode)};renderParamConditions();renderRuns();`);
}
const rule = (key, op, value = "") => ({id: key, key, op, value});

const tests = [
  ["numeric comparisons support scientific notation and numeric strings", () => {
    const app = fixture();
    rules(app, [rule("lr", "le", "1e-4"), rule("batch_size", "eq", "4")]);
    assert.deepEqual(ids(app), ["a"]);
    rules(app, [rule("lr", "lt", "1e-4")]);
    assert.deepEqual(ids(app), ["b"]);
  }],
  ["AND/OR rules combine with project filters without changing selected runs", () => {
    const app = fixture();
    rules(app, [rule("batch_size", "eq", "4"), rule("batch_size", "eq", "16")], "any");
    assert.deepEqual(ids(app), ["a", "c"]);
    app.nodes.get("project").value = "A";
    assert.deepEqual(ids(app), ["a"]);
    assert.deepEqual(app.value("[...state.selected]"), ["a", "b", "c"]);
  }],
  ["null, missing, boolean and array parameters remain distinct", () => {
    const app = fixture();
    for (const [condition, expected] of [[rule("optional", "eq", "null"), ["a"]],
      [rule("optional", "missing"), ["b", "c"]], [rule("flags", "eq", "false"), ["a", "c"]],
      [rule("weights", "eq", "[1,2]"), ["a", "b"]], [rule("optional", "ne", "null"), []]]) {
      rules(app, [condition]); assert.deepEqual(ids(app), expected);
    }
  }],
  ["nested keys and literal dotted keys do not collide", () => {
    const app = fixture();
    rules(app, [rule("optimizer.name", "contains", "ADAM")]);
    assert.deepEqual(ids(app), ["a", "b"]);
    rules(app, [rule('["literal.key"]', "eq", "9")]);
    assert.deepEqual(ids(app), ["a"]);
    assert(app.value('[...MiniParams.flatten(state.runs[0].config).keys()]').includes("optimizer.decay"));
  }],
  ["invalid numeric input matches nothing instead of widening a batch selection", () => {
    const app = fixture();
    rules(app, [rule("lr", "gt", "oops"), rule("flags", "eq", "true")], "any");
    assert.deepEqual(ids(app), []);
    rules(app, [rule("lr", "eq", "")]);
    assert.deepEqual(ids(app), ["a", "b", "c"]);
  }],
  ["comparison detects missing/null, number/string and ordered array differences", () => {
    const app = fixture();
    const result = app.value("MiniParams.rows(state.runs)");
    assert(result.rows.find(row => row.key === "lr").different);
    assert(result.rows.find(row => row.key === "optional").different);
    assert(result.rows.find(row => row.key === "weights").different);
    assert(!result.rows.find(row => row.key === "optimizer.decay").different);
    const only = app.value('MiniParams.rows(state.runs,"optimizer",true)');
    assert.deepEqual(only.rows.map(row => row.key), ["optimizer.name"]);
  }],
  ["parameter table uses all selected experiment metadata without downloading histories", () => {
    const app = fixture();
    assert.equal(app.nodes.get("config-comparison").hidden, false);
    const table = app.nodes.get("comparison-table").children[0];
    assert.equal(table.tag, "table");
    assert.equal(table.children[0].children[0].children.length, 4);
    app.nodes.get("config-only-diff").checked = true;
    app.nodes.get("config-key-search").value = "batch";
    app.run("renderComparison();");
    assert.match(app.nodes.get("comparison-count").textContent, /显示 1/);
  }],
  ["adding, editing and resetting conditions updates counts without clearing selection", () => {
    const app = fixture();
    app.click("add-param-filter");
    const row = app.nodes.get("param-conditions").children[0];
    row.children[0].value = "batch_size";
    row.children[1].children[1].value = "4";
    row.children[1].children[1].listeners.input();
    assert.deepEqual(ids(app), ["a"]);
    assert.match(app.nodes.get("filter-count").textContent, /1 条条件/);
    app.nodes.get("filter-panel").open = false;
    assert.deepEqual(ids(app), ["a"]);
    app.click("reset-filters");
    assert.deepEqual(ids(app), ["a", "b", "c"]);
    assert.equal(app.nodes.get("filter-count").textContent, "未启用");
    assert.equal(app.run("state.selected.size"), 3);
  }],
];
for (const [name, test] of tests) { test(); console.log("PASS", name); }
console.log(`${tests.length} parameter checks passed`);
