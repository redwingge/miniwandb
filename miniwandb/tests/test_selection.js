// Exercise the real dashboard handlers with a tiny DOM adapter, without dependencies.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const assets = path.join(__dirname, "../miniwandb/static");
const html = fs.readFileSync(path.join(assets, "index.html"), "utf8");
const source = fs.readFileSync(path.join(assets, "app.js"), "utf8").replace(/\nrefresh\(\);\s*$/, "\n");
const chartSource = fs.readFileSync(path.join(assets, "charts.js"), "utf8");
const parameterSource = fs.readFileSync(path.join(assets, "parameters.js"), "utf8");
const cvSource = fs.readFileSync(path.join(assets, "cv.js"), "utf8");
const evaluationSource = fs.readFileSync(path.join(assets, "evaluations.js"), "utf8");

function dashboard({network = false, evaluations = false, fetch = async () => { throw new Error("Unexpected network request"); }} = {}) {
  let document;
  class Element {
    constructor(tag = "div") {
      this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {};
      this.style = {}; this.value = ""; this.checked = false; this.disabled = false;
      this.textContent = ""; this.scrollTop = 0;
      this.scrollLeft = 0;
      this.selectedOptions = [{textContent: "Step"}];
      this.classList = {toggle: (name, enabled) => { const names = new Set((this.className || "").split(" ").filter(Boolean)); if (enabled) names.add(name); else names.delete(name); this.className = [...names].join(" "); }};
    }
    append(...children) { this.children.push(...children); }
    get firstElementChild() { return this.children[0] || null; }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this[key] = value; }
    getAttribute(key) { return this[key] === undefined ? null : String(this[key]); }
    getBoundingClientRect() { return {left: 0, top: 0, width: 640, height: 300}; }
    setPointerCapture(id) { this.capture = id; }
    hasPointerCapture(id) { return this.capture === id; }
    releasePointerCapture() { this.capture = null; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    querySelector() { if (!this.queryChild) this.queryChild = new Element(); return this.queryChild; }
    querySelectorAll(selector) {
      const found = [];
      function visit(node) { for (const child of node.children || []) { if (selector === "input[data-candidate-id]:checked" && child.tag === "input" && child.dataset.candidateId && child.checked) found.push(child); visit(child); } }
      visit(this); return found;
    }
    scrollIntoView() {}
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; if (this.listeners.close) this.listeners.close(); }
  }
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  document = {
    activeElement: new Element("body"), hidden: false,
    getElementById(id) { assert(nodes.has(id), `Missing HTML element: ${id}`); return nodes.get(id); },
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    createTextNode: text => ({textContent: text}), listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
  };
  const context = vm.createContext({document, fetch, AbortController, console,
    setTimeout: () => 1, clearTimeout() {}, setInterval() {}});
  vm.runInContext(parameterSource, context);
  vm.runInContext(cvSource, context);
  vm.runInContext(evaluationSource, context);
  if (!evaluations) vm.runInContext("MiniEvaluations.update = () => {};", context);
  vm.runInContext(chartSource, context);
  vm.runInContext(fs.readFileSync(path.join(assets, "reports.js"), "utf8"), context);
  vm.runInContext(source, context);
  if (!network) vm.runInContext("refresh = async () => {};", context);
  return {nodes, context,
    run: code => vm.runInContext(code, context),
    value: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)),
    click(id) { const node = nodes.get(id); if (!node.disabled) return node.listeners.click(); },
    change(id, checked) { const node = nodes.get(id); node.checked = checked; return node.listeners.change(); },
  };
}

const runs = [
  {id: "a", name: "MP_fold_0", project: "A", status: "finished", notes: "focal", tags: []},
  {id: "b", name: "MP_fold_1", project: "A", status: "failed", notes: "focal", tags: []},
  {id: "c", name: "CB_fold_2", project: "B", status: "failed", notes: "", tags: ["lora"]},
  {id: "d", name: "baseline", project: "B", status: "finished", notes: "", tags: []},
].map(run => ({...run, config: {}, summary: {}, created_at: 1000, updated_at: 2000}));

function fixture() {
  const app = dashboard();
  app.run(`state.runs = ${JSON.stringify(runs)}; state.initial = false; renderRuns();`);
  return app;
}

function purgeFixture(sourceError = null) {
  const calls = [];
  const app = dashboard({fetch: async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({url, payload});
    let response;
    if (url.endsWith("purge-preview")) response = {experiments: payload.ids.map(id => ({
      ...runs.find(run => run.id === id), metrics: 2, source: `/logs/${id}/history.jsonl`,
      target: `/logs/${id}/history.jsonl`, source_exists: true, source_error: sourceError,
    }))};
    else if (url.endsWith("/purge")) response = {deleted: payload.ids.length, metrics: payload.ids.length * 2,
      source_paths: payload.delete_sources ? payload.ids.map(id => `/logs/${id}/history.jsonl`) : []};
    else response = {before_bytes: 1048576, after_bytes: 4096};
    return {ok: true, json: async () => response};
  }});
  app.run(`state.runs = ${JSON.stringify(runs)}; state.initial = false; state.trash = true; state.selected = new Set(["a"]); renderRuns();`);
  return {...app, calls};
}

async function main() {
  const tests = [
    ["filters combine project, status, OR groups and AND keywords", () => {
      const app = fixture();
      app.nodes.get("project").value = "A";
      app.nodes.get("status-filter").value = "failed";
      app.nodes.get("search").value = "mp fold_1，lora";
      assert.deepEqual(app.value("visibleRuns().map(r => r.id)"), ["b"]);
      app.nodes.get("project").value = "";
      assert.deepEqual(app.value("visibleRuns().map(r => r.id)"), ["b", "c"]);
    }],
    ["only matching results clears hidden selections", () => {
      const app = fixture();
      app.run('state.selected = new Set(["a", "c"]);');
      app.nodes.get("search").value = "fold_1";
      app.click("select-filtered");
      assert.deepEqual(app.value("[...state.selected]"), ["b"]);
      assert.equal(app.run("state.focused"), "b");
      assert.equal(app.nodes.get("select-visible").checked, true);
    }],
    ["invert acts on visible matches and preserves hidden selections", () => {
      const app = fixture();
      app.run('state.selected = new Set(["a", "c"]);');
      app.nodes.get("project").value = "A";
      app.click("invert-selection");
      assert.deepEqual(app.value("[...state.selected].sort()"), ["b", "c"]);
      assert.equal(app.nodes.get("select-visible").indeterminate, true);
      assert.match(app.nodes.get("selection-summary").textContent, /1 个在筛选外/);
    }],
    ["master checkbox adds and removes only matching runs", () => {
      const app = fixture();
      app.run('state.selected = new Set(["c"]);');
      app.nodes.get("project").value = "A";
      app.change("select-visible", true);
      assert.deepEqual(app.value("[...state.selected].sort()"), ["a", "b", "c"]);
      app.change("select-visible", false);
      assert.deepEqual(app.value("[...state.selected]"), ["c"]);
      assert.equal(app.nodes.get("select-visible").checked, false);
      assert.equal(app.nodes.get("select-visible").indeterminate, false);
    }],
    ["all includes filtered-out runs and clear clears everything", () => {
      const app = fixture();
      app.nodes.get("search").value = "fold_1";
      app.click("select-all");
      assert.deepEqual(app.value("[...state.selected].sort()"), ["a", "b", "c", "d"]);
      assert.match(app.nodes.get("selection-summary").textContent, /3 个在筛选外/);
      app.click("clear");
      assert.deepEqual(app.value("[...state.selected]"), []);
      assert.equal(app.run("state.focused"), null);
      assert.equal(app.nodes.get("clear").disabled, true);
    }],
    ["empty filters disable scoped selection but leave select-all available", () => {
      const app = fixture();
      app.nodes.get("search").value = "does-not-exist";
      app.run("renderRuns();");
      for (const id of ["select-visible", "select-filtered", "invert-selection"]) assert.equal(app.nodes.get(id).disabled, true);
      assert.equal(app.nodes.get("select-all").disabled, false);
    }],
    ["list redraw preserves scroll position and checkbox keyboard focus", () => {
      const app = fixture();
      const list = app.nodes.get("runs");
      list.scrollTop = 190;
      const original = list.children[0].children[0].children[0];
      original.focus();
      app.run("renderRuns();");
      const replacement = list.children[0].children[0].children[0];
      assert.equal(original, replacement);
      app.run('state.runs[0].status="running";renderRuns();');
      assert.notEqual(original, list.children[0].children[0].children[0]);
      assert.equal(list.scrollTop, 190);
      assert.equal(app.run("document.activeElement.dataset.runId"), "a");
    }],
    ["purge preview and cancellation never send a delete request", async () => {
      const app = purgeFixture();
      await app.click("purge-selected");
      assert.equal(app.nodes.get("purge-dialog").open, true);
      assert.equal(app.nodes.get("delete-sources").checked, false);
      assert.deepEqual(app.calls.map(call => call.url), ["/api/runs/purge-preview"]);
      app.click("purge-cancel");
      assert.equal(app.nodes.get("purge-dialog").open, false);
      assert.equal(app.calls.length, 1);
    }],
    ["confirmed purge uses reviewed IDs and preserves original files by default", async () => {
      const app = purgeFixture();
      await app.click("purge-selected");
      app.run('state.selected = new Set(["b"]);');
      await app.click("purge-confirm");
      const mutation = app.calls.find(call => call.url === "/api/runs/purge");
      assert.deepEqual(mutation.payload, {ids: ["a"], confirm: true, delete_sources: false});
      assert.equal(app.nodes.get("purge-dialog").open, false);
      assert.deepEqual(app.value("state.runs.map(run => run.id)"), ["b", "c", "d"]);
    }],
    ["original source deletion is explicit and unsafe sources block confirmation", async () => {
      const app = purgeFixture();
      await app.click("purge-selected");
      app.change("delete-sources", true);
      await app.click("purge-confirm");
      assert.equal(app.calls.find(call => call.url === "/api/runs/purge").payload.delete_sources, true);
      const unsafe = purgeFixture("source shared by another experiment");
      await unsafe.click("purge-selected");
      unsafe.change("delete-sources", true);
      assert.equal(unsafe.nodes.get("purge-confirm").disabled, true);
      assert.match(unsafe.nodes.get("purge-error").textContent, /shared/);
      unsafe.click("purge-confirm");
      assert.equal(unsafe.calls.length, 1);
    }],
    ["empty trash previews the entire trash including filtered-out experiments", async () => {
      const app = purgeFixture();
      app.nodes.get("search").value = "fold_1";
      app.run("renderRuns();");
      await app.click("empty-trash");
      assert.deepEqual(app.calls[0].payload.ids, ["a", "b", "c", "d"]);
      assert.equal(app.calls.length, 1);
    }],
    ["bulk history loading is bounded and unchanged history is cached", async () => {
      const metadata = [...runs, ...runs.map(run => ({...run, id: run.id + "2"}))];
      let active = 0, peak = 0, historyRequests = 0;
      const app = dashboard({network: true, fetch: async url => {
        if (url === "/api/runs") return {ok: true, json: async () => JSON.parse(JSON.stringify({runs: metadata}))};
        active++; peak = Math.max(peak, active); historyRequests++;
        await new Promise(resolve => setTimeout(resolve, 3));
        active--;
        const id = url.split("/").pop();
        return {ok: true, json: async () => JSON.parse(JSON.stringify({run: metadata.find(run => run.id === id), history: [], metrics: []}))};
      }});
      app.run(`state.initial = false; state.selected = new Set(${JSON.stringify(metadata.map(r => r.id))});`);
      await app.run("refresh();");
      assert.equal(historyRequests, 8);
      assert.equal(peak, 4);
      await app.run("refresh();");
      assert.equal(historyRequests, 8, "unchanged historical data should not be downloaded again");
      metadata[0].updated_at++;
      await app.run("refresh();");
      assert.equal(historyRequests, 9, "changed experiments should fetch new history");
    }],
    ["training ticks do not rebuild unchanged sidebar rows",()=>{
      const app=fixture(), first=app.nodes.get('runs').children[0];
      app.run('state.runs[0].updated_at++;state.runs[0].last_step=99;state.runs[0].summary.loss=0.2;renderRuns();');
      assert.equal(app.nodes.get('runs').children[0],first);
      app.run('state.runs[0].status="running";renderRuns();');
      assert.notEqual(app.nodes.get('runs').children[0],first);
    }],
  ];
  for (const [name, test] of tests) { await test(); console.log("PASS", name); }
  console.log(`${tests.length} selection checks passed`);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = {dashboard, runs};
