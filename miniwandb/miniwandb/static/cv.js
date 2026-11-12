"use strict";

const MiniCV = (() => {
  const volatile = new Set(["fold", "fold_index", "kfold_set", "cv_id", "cv_name", "start_k", "k", "wandb_note", "wandb_run_name", "run_name", "model_dir", "data_size", "threshold"]);
  const collapsed = new Set();
  const expandedFolds = new Set();
  let dialogPlan = null, summaryKey = "", summaryScope = "", renderedSummary = "", summaryVersion = 0, lastSummary = null;
  function groups(runs) {
    const result = new Map();
    for (const run of runs) if (run.cv) {
      if (!result.has(run.cv.group_id)) result.set(run.cv.group_id, {...run.cv, members: []});
      result.get(run.cv.group_id).members.push(run);
    }
    return [...result.values()];
  }
  function representative(attempts) {
    const completed = attempts.filter(run => run.status === "finished");
    const preferred = completed.filter(run => run.cv.preferred);
    return [...(preferred.length ? preferred : completed.length ? completed : attempts)].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))[0];
  }
  function representatives(group) {
    const result = [];
    for (let fold = 0; fold < group.n_splits; fold++) {
      const chosen = representative(group.members.filter(run => run.cv.fold === fold));
      if (chosen) result.push(chosen);
    }
    return result;
  }
  function selectedGroups() { return groups(state.runs).filter(group => group.members.some(run => state.selected.has(run.id))); }
  function parameters(group) {
    const chosen = representatives(group), perRun = chosen.map(run => {
      const map = new Map([...MiniParams.flatten(run.config)].filter(([key]) => !volatile.has(key)));
      if (typeof map.get("model_type") === "string") map.set("model_type", map.get("model_type").replace(/^\d+_(\d+fold)/, "{fold}_$1"));
      return map;
    });
    const values = [];
    for (const key of new Set(perRun.flatMap(map => [...map.keys()]))) {
      const cells = perRun.map((map, i) => ({fold: chosen[i].cv.fold, present: map.has(key), value: map.get(key)}));
      const different = new Set(cells.map(cell => cell.present ? MiniParams.canonical(cell.value) : "missing")).size > 1;
      values.push([key, different ? {__miniwandb_cv_variation: true, folds: cells} : cells[0].value]);
    }
    return values;
  }
  function parameterRuns(selected) {
    if ($("comparison-layout").value !== "groups") return selected;
    return [...selectedGroups().map(group => ({id: group.group_id, name: group.name, project: group.project,
      status: `${representatives(group).filter(run => run.status === "finished").length}/${group.n_splits} 折完成`,
      config: {}, comparisonValues: parameters(group)})), ...selected.filter(run => !run.cv)];
  }
  function choose(ids, checked, remove) {
    state.initial = false;
    if (checked) for (const id of ids) state.selected.add(id);
    else for (const id of remove || ids) state.selected.delete(id);
    if (!state.selected.has(state.focused)) state.focused = state.selected.values().next().value || null;
    renderRuns(); renderCharts(); renderDetails(); refresh();
  }
  function targets(container, visible, all) {
    const result = new Map();
    if ($("run-layout").value !== "groups") return result;
    for (const group of groups(visible)) {
      const complete = groups(all).find(item => item.group_id === group.group_id) || group;
      const primary = representatives(complete), visiblePrimary = representatives(group);
      const details = element("details", "cv-list-group"); details.dataset.cvGroup = group.group_id;
      details.open = !collapsed.has(group.group_id);
      details.addEventListener("toggle", () => { if (details.open) collapsed.delete(group.group_id); else collapsed.add(group.group_id); });
      const summary = element("summary"), checkbox = element("input"); checkbox.type = "checkbox";
      const selected = visiblePrimary.filter(run => state.selected.has(run.id)).length;
      checkbox.checked = !!visiblePrimary.length && selected === visiblePrimary.length;
      checkbox.indeterminate = selected > 0 && selected < visiblePrimary.length;
      checkbox.setAttribute("aria-label", `勾选 ${group.name} 当前可见的各 fold`);
      checkbox.title = "勾选当前筛选中每折的代表记录；取消勾选则取消本组当前可见记录";
      checkbox.addEventListener("click", event => event.stopPropagation());
      checkbox.addEventListener("change", () => choose(visiblePrimary.map(run => run.id), checkbox.checked, group.members.map(run => run.id)));
      const label = element("span", "cv-group-label");
      label.append(element("strong", "", group.name), element("small", "", `${group.project} · 完成 ${primary.filter(run => run.status === "finished").length}/${group.n_splits} 折 · ${complete.members.length} 次记录`));
      label.title = `${group.name} [${group.group_id}]\n${group.project} · 完成 ${primary.filter(run => run.status === "finished").length}/${group.n_splits} 折 · ${complete.members.length} 次记录`;
      const seeds = [...new Set(primary.map(run => run.config?.seed).filter(value => value !== undefined))];
      const identity = element("small", "", `${seeds.length === 1 ? `seed ${seeds[0]} · ` : ""}#${group.group_id.slice(-6)}${group.group_created_at ? ` · ${date(group.group_created_at)}` : ""}`);
      identity.className = "cv-group-identity";
      identity.title = group.group_id; label.append(identity);
      label.title += `\n${identity.textContent}`;
      summary.append(checkbox, label); details.append(summary);
      for (let fold = 0; fold < group.n_splits; fold++) {
        const attempts = group.members.filter(run => run.cv.fold === fold), full = complete.members.filter(run => run.cv.fold === fold);
        if (!attempts.length) {
          details.append(element("div", "cv-fold-empty", `fold ${fold} · ${full.length ? "当前筛选未匹配" : "未运行"}`));
          continue;
        }
        const bucket = element(attempts.length > 1 ? "details" : "div", "cv-fold");
        if (attempts.length > 1) {
          const foldKey = `${group.group_id}/${fold}`;
          bucket.open = expandedFolds.has(foldKey);
          bucket.addEventListener("toggle", () => { if (bucket.open) expandedFolds.add(foldKey); else expandedFolds.delete(foldKey); });
        }
        const heading = element(attempts.length > 1 ? "summary" : "div", "cv-fold-title", `fold ${fold}${attempts.length > 1 ? ` · ${attempts.length} 次尝试` : ""}`);
        bucket.append(heading);
        const chosen = representative(full);
        for (const run of [...attempts].sort((a, b) => b.created_at - a.created_at)) {
          const wrapper = element("div", "cv-attempt"), host = element("div"), tools = element("div", "cv-attempt-tools");
          const used = chosen && chosen.id === run.id && run.status === "finished";
          tools.append(element("span", used ? "cv-used" : "", used ? run.cv.preferred ? "已指定统计" : "默认统计" : run.status !== "finished" ? "未完成，不计入统计" : "历史尝试"));
          if (run.status === "finished" && !state.trash) {
            const action = element("button", "text-button", run.cv.preferred ? "取消指定" : "用于统计");
            action.disabled = state.mutating;
            action.addEventListener("click", () => mutate("/api/cv/prefer", {ids: [run.id], preferred: !run.cv.preferred}, "已更新本折的统计记录"));
            tools.append(action);
          }
          wrapper.append(host, tools); bucket.append(wrapper); result.set(run.id, host);
        }
        details.append(bucket);
      }
      container.append(details);
    }
    const plain = visible.filter(run => !run.cv);
    if (plain.length) {
      const details = element("details", "cv-list-group cv-ungrouped"); details.open = !collapsed.has("__ungrouped");
      details.addEventListener("toggle", () => { if (details.open) collapsed.delete("__ungrouped"); else collapsed.add("__ungrouped"); });
      details.append(element("summary", "", `未归组（${plain.length}）`));
      const host = element("div"); details.append(host); container.append(details);
      for (const run of plain) result.set(run.id, host);
    }
    return result;
  }
  function error(message) { $("error").hidden = false; $("error").textContent = message; }
  async function mutate(path, payload, message) {
    if (state.mutating) return;
    state.mutating = true; renderRuns();
    try {
      await post(path, payload); summaryKey = "";
      $("notice").hidden = false; $("notice").textContent = message;
      await refresh();
    } catch (problem) { error(problem.message); }
    finally { state.mutating = false; renderRuns(); }
  }
  function manualRows(info, splits) {
    const holder = $("cv-dialog-items"); holder.replaceChildren();
    for (const run of info) {
      const row = element("div", "cv-edit-row"), name = element("div");
      name.append(element("strong", "", run.name), element("small", "", `${run.project} / ${run.id}${run.group_id ? " · 已有分组" : ""}`));
      if (run.warnings.length) name.append(element("small", "cv-warning", run.warnings.join("；")));
      const select = element("select", "cv-fold-input"); select.dataset.runId = run.id;
      select.setAttribute("aria-label", `${run.name} 的 fold`);
      const empty = element("option", "", "请选择 fold"); empty.value = ""; select.append(empty);
      for (let fold = 0; fold < splits; fold++) { const option = element("option", "", `fold ${fold}`); option.value = String(fold); select.append(option); }
      select.value = run.fold !== null && run.fold < splits ? String(run.fold) : "";
      select.addEventListener("change", () => { run.fold = select.value === "" ? null : Number(select.value); });
      row.append(name, select); holder.append(row);
    }
  }
  async function openDialog(mode) {
    const ids = mode === "manual" ? [...state.selected] : visibleRuns().filter(run => !run.cv).map(run => run.id);
    if (!ids.length || state.mutating) return;
    state.mutating = true; renderRuns();
    try {
      const preview = await post("/api/cv/preview", {ids});
      dialogPlan = {mode, ids, preview};
      $("cv-dialog-error").hidden = true;
      $("cv-manual-fields").hidden = mode !== "manual";
      $("cv-allow-move-row").hidden = mode !== "manual";
      $("cv-allow-move").checked = false;
      $("cv-dialog-title").textContent = mode === "manual" ? "将所选记录收纳到 CV 组" : "预览筛选内旧记录的候选分组";
      $("cv-dialog-description").textContent = mode === "manual" ? "每条记录选择 0 起始的 fold。同一 fold 的多次尝试会一起保留，统计只取一条代表记录。" : "候选组不会自动写入。核对日期、参数和 fold 后勾选确认；有冲突的记录请手动归组。";
      $("cv-dialog-confirm").textContent = "确认归组";
      if (mode === "manual") {
        const projects = new Set(preview.runs.map(run => run.project));
        if (projects.size > 1) throw new Error("请先选择同一项目的实验进行归组；不同项目可在组间比较");
        $("cv-group-name").value = selectedMetadata()[0]?.config?.cv_name || selectedMetadata()[0]?.config?.wandb_run_name || "交叉验证实验";
        $("cv-splits").value = String(preview.runs[0]?.n_splits || 5);
        $("cv-existing").replaceChildren();
        const option = element("option", "", "创建新 CV 组"); option.value = ""; $("cv-existing").append(option);
        for (const group of groups(state.runs).filter(group => group.project === preview.runs[0].project)) {
          const option = element("option", "", `${group.name}（${group.n_splits} 折）`); option.value = group.group_id; $("cv-existing").append(option);
        }
        $("cv-existing").value = "";
        manualRows(preview.runs, Number($("cv-splits").value));
      } else {
        $("cv-dialog-items").replaceChildren();
        if (!preview.candidates.length) $("cv-dialog-items").append(element("p", "", "当前筛选内没有未归组记录"));
        for (const candidate of preview.candidates) {
          const card = element("div", "cv-candidate"), label = element("label"), checkbox = element("input"); checkbox.type = "checkbox";
          checkbox.dataset.candidateId = candidate.id; checkbox.disabled = candidate.blocked;
          label.append(checkbox, element("strong", "", `${candidate.name} · ${candidate.project} · ${candidate.n_splits} 折`));
          card.append(label);
          for (const warning of candidate.warnings) card.append(element("p", "cv-warning", warning));
          const config = element("details", "cv-candidate-config");
          config.append(element("summary", "", "查看候选共用参数"), element("pre", "", JSON.stringify(candidate.config, null, 2)));
          card.append(config);
          for (const run of candidate.runs) card.append(element("small", "", `fold ${run.fold ?? "?"} · ${run.name} · ${date(run.created_at)}`));
          $("cv-dialog-items").append(card);
        }
      }
      $("cv-dialog").showModal();
    } catch (problem) { dialogPlan = null; error(problem.message); }
    finally { state.mutating = false; renderRuns(); }
  }
  async function confirmDialog() {
    if (!dialogPlan || state.mutating) return;
    const plan = dialogPlan;
    let path, payload;
    if (plan.mode === "manual") {
      const splits = Number($("cv-splits").value);
      path = "/api/cv/assign";
      payload = {ids: plan.ids, name: $("cv-group-name").value, n_splits: splits,
        group_id: $("cv-existing").value || null, allow_move: $("cv-allow-move").checked,
        folds: Object.fromEntries(plan.preview.runs.map(run => [run.id, run.fold])), confirm: true};
    } else {
      path = "/api/cv/apply";
      payload = {ids: plan.ids, candidate_ids: [...$("cv-dialog-items").querySelectorAll("input[data-candidate-id]:checked")].map(input => input.dataset.candidateId), confirm: true};
    }
    state.mutating = true; $("cv-dialog-confirm").disabled = true; $("cv-dialog-cancel").disabled = true;
    try {
      await post(path, payload); summaryKey = "";
      $("cv-dialog").close(); $("run-layout").value = "groups";
      $("notice").hidden = false; $("notice").textContent = "归组已保存，原始参数和曲线保持完整。可展开 CV 组勾选各 fold。";
      await refresh();
    } catch (problem) { $("cv-dialog-error").hidden = false; $("cv-dialog-error").textContent = problem.message; }
    finally { state.mutating = false; $("cv-dialog-confirm").disabled = false; $("cv-dialog-cancel").disabled = false; renderRuns(); }
  }
  function renderSummary(payload) {
    const holder = $("cv-summary-table"), left = holder.scrollLeft, top = holder.scrollTop;
    const signature = JSON.stringify([payload, groups(state.runs).filter(group => payload.groups.some(row => row.id === group.group_id)).map(group => parameters(group))]);
    if (renderedSummary === signature && holder.children.length) { holder.removeAttribute?.("aria-busy"); return; }
    renderedSummary = signature;
    const previousDetails = Array.from(holder.children).find(node => node.className === "cv-fold-results");
    const table = element("table", "cv-summary-table"), head = element("thead"), row = element("tr");
    const sourceLabel = payload.source === "evaluation" ? `最终评估 / ${payload.dataset} / ${payload.evaluation} / ${payload.metric}` : `训练历史 / ${payload.metric} / ${{max: "每折最大值", min: "每折最小值", last: "每折最后值"}[payload.reduction] || payload.reduction}`;
    table.append(element("caption", "cv-summary-caption", sourceLabel));
    for (const label of ["CV 组", "完成折数", "参与统计", "均值 ± 标准差", "最小 / 最大", "参数一致性"]) row.append(element("th", "", label));
    head.append(row); table.append(head); const body = element("tbody");
    for (const group of payload.groups) {
      const row = element("tr"), name = element("td");
      name.append(element("strong", "", group.name), element("small", "", `${group.project} · #${group.id.slice(-6)}`));
      const metadata = groups(state.runs).find(item => item.group_id === group.id);
      const differences = metadata ? parameters(metadata).filter(([, value]) => value?.__miniwandb_cv_variation).length : 0;
      row.append(name, element("td", "", `${group.completed}/${group.n_splits}`), element("td", "", `${group.n} 折`),
        element("td", "cv-mean", `${format(group.mean)} ± ${format(group.std)}`), element("td", "", `${format(group.min)} / ${format(group.max)}`),
        element("td", differences ? "cv-warning" : "", differences ? `${differences} 项组内差异` : "一致"));
      body.append(row);
    }
    table.append(body);
    const details = element("details", "cv-fold-results"); details.open = !!previousDetails?.open;
    details.append(element("summary", "", "查看各 fold 的取值及所用记录"));
    for (const group of payload.groups) {
      details.append(element("strong", "", `${group.name} / ${group.project}`));
      for (const fold of group.folds) {
        const reason = {evaluation_not_recorded: "代表记录未保存该测试集 / 版本", metric_not_recorded: "未记录该指标", missing_value: "指标值缺失"}[fold.missing_reason];
        const checkpoint = fold.evaluation_metadata?.checkpoint;
        details.append(element("p", "", `fold ${fold.fold} · ${format(fold.value)} · ${fold.name || "未运行"} ${fold.run_id ? `[${fold.run_id}]` : ""} · ${fold.attempts} 次记录${fold.preferred ? " · 手动指定" : ""}${fold.value_source === "summary" ? " · 训练摘要" : ""}${checkpoint !== undefined ? ` · checkpoint: ${typeof checkpoint === "object" ? JSON.stringify(checkpoint) : checkpoint}` : ""}${fold.status !== "finished" ? " · 未完成，不计入统计" : reason ? ` · ${reason}` : ""}`));
      }
    }
    holder.replaceChildren(table, details); holder.scrollLeft = left; holder.scrollTop = top;
    holder.removeAttribute?.("aria-busy");
  }
  function options(id, values, preferred, scope = "") {
    const select = $(id), signature = JSON.stringify([scope, values]);
    if (select.dataset.options !== signature) {
      const previous = select.value;
      select.dataset.options = signature; select.replaceChildren();
      for (const value of values) { const option = element("option", "", value); option.value = value; select.append(option); }
      select.value = values.includes(previous) ? previous : values.includes(preferred) ? preferred : values[0] || "";
    }
    select.disabled = !values.length;
    return select.value;
  }
  function clearSummary(message) {
    summaryKey = ""; summaryScope = ""; summaryVersion++; lastSummary = null;
    $("cv-export-summary").disabled = true; $("cv-summary-table").replaceChildren();
    $("cv-summary-table").removeAttribute?.("aria-busy");
    $("cv-summary-status").textContent = message;
  }
  function update() {
    const chosen = selectedGroups();
    $("cv-overview").hidden = !chosen.length;
    if (!chosen.length) { clearSummary(""); return; }
    const catalog = chosen.flatMap(group => group.members.flatMap(run => run.evaluation_keys || []));
    const requestedSource = $("cv-source").value || "auto";
    const source = requestedSource === "auto" ? catalog.length ? "evaluation" : "history" : requestedSource;
    const final = source === "evaluation";
    $("cv-dataset-field").hidden = !final; $("cv-evaluation-field").hidden = !final;
    $("cv-reduction-field").hidden = final; $("cv-reduction").disabled = final;
    let dataset = null, evaluation = null, keys;
    if (final) {
      dataset = options("cv-dataset", [...new Set(catalog.map(item => item.dataset))].sort());
      const records = catalog.filter(item => item.dataset === dataset);
      evaluation = options("cv-evaluation", [...new Set(records.map(item => item.name))].sort(), "final", dataset);
      keys = [...new Set(records.filter(item => item.name === evaluation).flatMap(item => item.metrics))].sort();
    } else {
      keys = [...new Set(chosen.flatMap(group => group.members.flatMap(run => Object.keys(run.summary || {}).filter(key => !key.startsWith("_") && key !== "epoch"))))].sort();
    }
    const preferred = final ? keys.find(key => key.toLowerCase() === "mcc") : ["valid/mcc", "best/mcc", "valid/auroc_all"].find(key => keys.includes(key)) || keys.find(key => key.startsWith("valid/"));
    const metric = options("cv-metric", keys, preferred, JSON.stringify([source, dataset, evaluation]));
    $("cv-export-summary").disabled = !lastSummary;
    const reduction = final ? "final" : $("cv-reduction").value || "max";
    if (!metric) { clearSummary(final ? "所选组尚无最终评估；请保存 log_evaluation 结果，或切换到训练 / 验证历史。" : "所选组尚无训练 / 验证指标"); return; }
    const scope = JSON.stringify([chosen.map(group => group.group_id), source, dataset, evaluation, metric, reduction, state.trash]);
    const key = JSON.stringify([chosen.map(group => [group.group_id, group.members.map(run => [run.id, final ? run.evaluations_updated_at : run.status === "finished" ? run.updated_at : null, !final && run.status === "finished" ? run.last_step : null, run.status, run.cv])]), scope]);
    if (key === summaryKey) return;
    summaryKey = key; lastSummary = null; const version = ++summaryVersion;
    $("cv-export-summary").disabled = true;
    if (scope !== summaryScope) $("cv-summary-table").replaceChildren();
    summaryScope = scope; $("cv-summary-table").setAttribute("aria-busy", "true");
    $("cv-summary-status").textContent = "正在汇总所选实验所属的完整 CV 组…";
    post("/api/cv/summary", {group_ids: chosen.map(group => group.group_id), source, dataset, evaluation, metric, reduction, trashed: state.trash})
      .then(payload => { if (version !== summaryVersion) return; lastSummary = payload; renderSummary(payload); $("cv-summary-status").textContent = `${final ? `最终评估：${dataset} / ${evaluation} / ${metric}。每折直接使用已保存分数；代表记录缺失时不回退到旧尝试。` : "训练历史：按每折所选口径取值。"}只统计已完成且有数值的折；每折取指定或最近成功记录，缺失不补零，标准差使用 ddof=1。`; $("cv-export-summary").disabled = false; })
      .catch(problem => { if (version === summaryVersion) { summaryKey = ""; $("cv-summary-status").textContent = `汇总失败：${problem.message}`; } });
  }
  function exportSummary() {
    if (!lastSummary) return;
    const quote = value => { const raw = typeof value === "string" && /^[=+@-]/.test(value) ? "'" + value : String(value ?? ""); return '"' + raw.replace(/"/g, '""') + '"'; };
    const rows = [["group", "cv_group_id", "project", "source", "dataset", "evaluation", "metric", "reduction", "completed", "n_splits", "n", "mean", "std_ddof1", "min", "max", "fold_records"]];
    for (const group of lastSummary.groups) rows.push([group.name, group.id, group.project, lastSummary.source || "history", lastSummary.dataset, lastSummary.evaluation, lastSummary.metric, lastSummary.reduction, group.completed, group.n_splits, group.n, group.mean, group.std, group.min, group.max, JSON.stringify(group.folds)]);
    const blob = new Blob(["\ufeff" + rows.map(row => row.map(quote).join(",")).join("\r\n")], {type: "text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob), link = element("a"); link.href = url; link.download = "cross_validation_summary.csv";
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function init() {
    $("cv-manual-group").addEventListener("click", () => openDialog("manual"));
    $("cv-auto-group").addEventListener("click", () => openDialog("auto"));
    $("run-layout").addEventListener("change", renderRuns);
    $("comparison-layout").addEventListener("change", renderComparison);
    $("cv-metric").addEventListener("change", update); $("cv-reduction").addEventListener("change", update);
    for (const id of ["cv-source", "cv-dataset", "cv-evaluation"]) $(id).addEventListener("change", update);
    $("cv-export-summary").addEventListener("click", exportSummary);
    $("cv-compare-params").addEventListener("click", () => { $("comparison-layout").value = "groups"; renderComparison(); $("config-comparison").scrollIntoView({block: "start", behavior: "smooth"}); });
    $("cv-dialog-confirm").addEventListener("click", confirmDialog);
    $("cv-dialog-cancel").addEventListener("click", () => { if (!state.mutating) $("cv-dialog").close(); });
    $("cv-dialog").addEventListener("cancel", event => { if (state.mutating) event.preventDefault(); });
    $("cv-dialog").addEventListener("close", () => { dialogPlan = null; });
    $("cv-splits").addEventListener("change", () => { const splits = Number($("cv-splits").value); if (dialogPlan && Number.isInteger(splits) && splits >= 2 && splits <= 100) manualRows(dialogPlan.preview.runs, splits); });
    $("cv-existing").addEventListener("change", () => {
      const group = groups(state.runs).find(group => group.group_id === $("cv-existing").value);
      if (group && dialogPlan) { $("cv-group-name").value = group.name; $("cv-splits").value = String(group.n_splits); manualRows(dialogPlan.preview.runs, group.n_splits); }
    });
  }
  return {init, groups, representative, representatives, selectedGroups, parameters, parameterRuns, targets, update,
    analysisMetric: () => lastSummary?.source === "evaluation" ? "" : $("cv-metric").value};
})();
