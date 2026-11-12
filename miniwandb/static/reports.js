"use strict";

// Local-only evidence export; no calls to an AI provider or other external service.
const MiniReports = (() => {
  let config, ids = [], controller = null;
  const get = id => document.getElementById(id);
  function update() { get("export-ai").disabled = !config.getIds().length; }
  function open() {
    ids = [...config.getIds()];
    get("ai-export-scope").textContent = `已选 ${ids.length} 条实验；导出时还会包含同一视图下所属 CV 组的全部记录。展开后最多 100 条，可分批导出。`;
    get("ai-export-confirm").disabled = !ids.length || ids.length > 100;
    get("ai-export-status").textContent = "统计来自完整历史，长曲线最多抽样 300 点；不修改实验，也不会自动发送给 AI。";
    get("ai-primary").value = config.getPrimaryMetric?.() || "";
    get("ai-export-dialog").showModal();
  }
  async function generate() {
    if (controller || !ids.length || ids.length > 100) return;
    controller = new AbortController(); const signal = controller.signal;
    get("ai-export-confirm").disabled = true; get("ai-export-confirm").textContent = "正在生成…";
    get("ai-export-status").textContent = "正在读取选中实验并生成报告，大量历史数据可能需要一些时间…";
    try {
      const primary = get("ai-primary").value.trim(), direction = get("ai-direction").value || null;
      const response = await fetch("/api/analysis/export", {method: "POST", signal,
        headers: {"Content-Type": "application/json", "X-MiniWandb-Request": "1"},
        body: JSON.stringify({ids, trashed: config.getTrash(), primary_metric: primary || null, direction,
          step_unit: get("ai-step-unit").value || "unknown", context: get("ai-context").value,
          evaluation_protocol: get("ai-protocol").value, include_output: get("ai-include-output").checked})});
      if (!response.ok) { const payload = await response.json(); throw new Error(payload.error || `HTTP ${response.status}`); }
      const blob = await response.blob(); if (signal.aborted) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = "miniwandb_ai_analysis.zip"; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      get("ai-export-status").textContent = "已生成。将 ZIP 解压后的 analysis_instructions.md、report.md 和 JSON/CSV 一起交给 AI 即可。";
    } catch (problem) {
      get("ai-export-status").textContent = signal.aborted ? "已取消下载。" : `导出失败：${problem.message}`;
    } finally {
      controller = null; get("ai-export-confirm").textContent = "生成并下载 ZIP";
      get("ai-export-confirm").disabled = !ids.length || ids.length > 100;
    }
  }
  function cancel() { controller?.abort(); get("ai-export-dialog").close(); }
  function init(options) {
    config = options;
    get("export-ai").addEventListener("click", open);
    get("ai-export-confirm").addEventListener("click", generate);
    get("ai-export-cancel").addEventListener("click", cancel);
    get("ai-export-dialog").addEventListener("cancel", () => controller?.abort());
    update();
  }
  return {init, update};
})();
