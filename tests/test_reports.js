const assert = require("node:assert/strict");
const {dashboard} = require("./test_selection");

function fixture(fetch) {
  const app = dashboard({fetch});
  app.run(`state.selected = new Set(["a", "b"]); MiniReports.update();
    globalThis.downloads = [];
    globalThis.URL = {createObjectURL: () => "blob:local-export", revokeObjectURL() {}};
    document.body = {append() {}};
    const originalCreate = document.createElement;
    document.createElement = tag => tag === "a" ? {click() { downloads.push(this.download); }, remove() {}} : originalCreate(tag);`);
  app.nodes.get("ai-include-output").checked = true;
  return app;
}

async function main() {
  const tests = [
    ["export freezes chosen IDs and sends context, metric direction and local download", async () => {
      const calls = [];
      const app = fixture(async (url, options) => {
        calls.push({url, options, payload: JSON.parse(options.body)});
        return {ok: true, blob: async () => ({})};
      });
      assert.equal(app.nodes.get("export-ai").disabled, false);
      app.click("export-ai");
      assert(app.nodes.get("ai-export-dialog").open);
      app.run('state.selected.clear();');
      app.nodes.get("ai-primary").value = "valid/loss";
      app.nodes.get("ai-direction").value = "min";
      app.nodes.get("ai-step-unit").value = "batch";
      app.nodes.get("ai-context").value = "classification";
      app.nodes.get("ai-protocol").value = "validation checkpoint";
      await app.click("ai-export-confirm");
      assert.equal(calls[0].url, "/api/analysis/export");
      assert.equal(calls[0].options.headers["X-MiniWandb-Request"], "1");
      assert.deepEqual(calls[0].payload, {ids: ["a", "b"], trashed: false,
        primary_metric: "valid/loss", direction: "min", step_unit: "batch",
        context: "classification", evaluation_protocol: "validation checkpoint", include_output: true});
      assert.deepEqual(app.value("downloads"), ["miniwandb_ai_analysis.zip"]);
    }],
    ["errors remain in the dialog and do not download a corrupt file", async () => {
      const app = fixture(async () => ({ok: false, json: async () => ({error: "too many CV records"})}));
      app.click("export-ai"); await app.click("ai-export-confirm");
      assert(app.nodes.get("ai-export-status").textContent.includes("too many CV records"));
      assert.deepEqual(app.value("downloads"), []);
      assert.equal(app.nodes.get("ai-export-confirm").disabled, false);
    }],
    ["closing an in-progress export aborts the request", async () => {
      let signal;
      const app = fixture(async (_, options) => new Promise((resolve, reject) => {
        signal = options.signal;
        signal.addEventListener("abort", () => reject(new Error("cancelled")));
      }));
      app.click("export-ai"); const task = app.click("ai-export-confirm");
      app.click("ai-export-cancel"); await task;
      assert(signal.aborted);
      assert.equal(app.nodes.get("ai-export-dialog").open, false);
      assert.deepEqual(app.value("downloads"), []);
    }],
  ];
  for (const [name, test] of tests) { await test(); console.log("PASS", name); }
  console.log(`${tests.length} AI report checks passed`);
}
main().catch(error => {console.error(error); process.exitCode = 1;});
