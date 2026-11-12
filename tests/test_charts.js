const assert = require("node:assert/strict");
const {dashboard, runs} = require("./test_selection");

function all(root, predicate) {
  const result = [];
  function visit(node) { if (predicate(node)) result.push(node); for (const child of node.children || []) visit(child); }
  visit(root); return result;
}
function text(root) { return all(root, node => !!node.textContent).map(node => node.textContent).join("\n"); }
function fixture() {
  const app = dashboard();
  const data = runs.slice(0, 2).map(run => ({run, metrics: ["valid/sp", "valid/sn", "train/loss", "epoch"],
    history: Array.from({length: 60}, (_, step) => ({step, timestamp: 1000 + step, metrics: {
      "valid/sp": 0.7 + step * 0.003, "valid/sn": 0.9 - step * 0.001, "train/loss": 1 / (step + 1), epoch: step,
    }}))}));
  app.run(`state.selected = new Set(["a", "b"]); state.data = new Map(${JSON.stringify(data.map(d => [d.run.id, d]))}); document.getElementById("x-axis").value="step"; renderCharts();`);
  return app;
}
function card(app, metric) { return all(app.nodes.get("charts"), node => node.dataset && node.dataset.metric === metric)[0]; }
function hit(root) { return all(root, node => !!node["data-chart-hit"])[0]; }
function button(root, label) { return all(root, node => node.tag === "button" && node.textContent === label)[0]; }
const event = values => ({preventDefault() {}, stopPropagation() {}, pointerId: 1, ...values});

const tests = [
  ["metric prefixes become collapsible groups and nested leaves retain their names", () => {
    const app = fixture();
    assert.deepEqual(app.value('MiniCharts.parts("valid/bacteria/sp")'), {group: "valid", name: "bacteria/sp"});
    assert.deepEqual(app.value('MiniCharts.parts("epoch")'), {group: "其他指标", name: "epoch"});
    const groups = app.nodes.get("charts").children;
    assert.deepEqual(groups.map(node => node.dataset.group), ["train", "valid", "其他指标"]);
    app.click("collapse-groups");
    assert(groups.every(node => !node.open));
    app.click("expand-groups");
    assert(groups.every(node => node.open));
    assert.equal(all(app.nodes.get("charts"), node => node.className === "chart-card").length, 4);
  }],
  ["right drag zooms both axes and reset restores the original range", () => {
    const app = fixture(), plot = card(app, "valid/sp");
    const before = all(plot, node => node.tag === "path")[0].d;
    hit(plot).listeners.pointerdown(event({button: 2, clientX: 210, clientY: 76}));
    hit(plot).listeners.pointermove(event({clientX: 486, clientY: 192}));
    hit(plot).listeners.pointerup(event({button: 2, clientX: 486, clientY: 192}));
    assert.equal(button(plot, "还原").disabled, false);
    assert.notEqual(all(plot, node => node.tag === "path")[0].d, before);
    button(plot, "还原").listeners.click();
    assert.equal(button(plot, "还原").disabled, true);
    assert.equal(all(plot, node => node.tag === "path")[0].d, before);
  }],
  ["tiny right clicks do not zoom and reversed drags produce ordered bounds", () => {
    const app = fixture();
    assert.equal(app.run('MiniCharts.selectionRange({xmin:0,xmax:100,ymin:0,ymax:1},{x:100,y:50},{x:102,y:52})'), null);
    const result = app.value('MiniCharts.selectionRange({xmin:0,xmax:100,ymin:0,ymax:1},{x:500,y:220},{x:150,y:40})');
    assert(result.xmin < result.xmax && result.ymin < result.ymax);
  }],
  ["hover lists every experiment as Name Step Value and supports folded names", () => {
    const app = fixture(), plot = card(app, "valid/sp");
    hit(plot).listeners.pointermove(event({clientX: 250, clientY: 140}));
    const tip = all(plot, node => node.className === "curve-tooltip")[0];
    assert.equal(tip.hidden, false);
    const body = all(tip, node => node.tag === "tbody")[0];
    assert.equal(body.children.length, 2);
    for (const row of body.children) { assert.equal(row.children.length, 3); assert(row.children[1].textContent); assert(row.children[2].textContent); assert(row.style.color); }
    button(tip, "展开名称").listeners.click();
    assert(tip.className.includes("expanded-names"));
    assert(button(tip, "折叠名称"));
  }],
  ["pinned data panels defer automatic redraw until closed", () => {
    const app = fixture(), first = card(app, "valid/sp");
    const before = all(first, node => node.tag === "svg")[0];
    hit(first).listeners.pointermove(event({clientX: 250, clientY: 140}));
    const tip = all(first, node => node.className === "curve-tooltip")[0];
    button(tip, "固定").listeners.click();
    app.run("renderCharts(false);");
    assert.equal(card(app, "valid/sp"), first);
    button(tip, "×").listeners.click();
    assert.equal(card(app, "valid/sp"), first);
    assert.notEqual(all(first, node => node.tag === "svg")[0], before);
  }],
  ["live updates preserve chart and group nodes while updating plotted values", () => {
    const app = fixture(), first = card(app, "valid/sp"), groups = [...app.nodes.get("charts").children];
    const before = all(first, node => node.tag === "path")[0].d;
    app.run('state.data.get("a").history.push({step:60,timestamp:1060,metrics:{epoch:60,"valid/sp":0.99}});renderCharts(false);');
    assert.equal(card(app, "valid/sp"),first);
    assert(app.nodes.get("charts").children.every((node,index)=>node===groups[index]));
    assert.notEqual(all(first,node=>node.tag==="path")[0].d,before);
    app.click("collapse-groups");app.run('renderCharts(false);');
    assert(app.nodes.get("charts").children.every(node=>!node.open));
  }],
  ["Escape cancels a drag or closes a pinned panel from outside the SVG", () => {
    const app = fixture(), plot = card(app, "valid/sp");
    hit(plot).listeners.pointerdown(event({button: 2, clientX: 210, clientY: 76}));
    app.run('document.listeners.keydown({key:"Escape"});');
    assert.equal(button(plot, "还原").disabled, true);
    hit(plot).listeners.pointermove(event({clientX: 250, clientY: 140}));
    const tip = all(plot, node => node.className === "curve-tooltip")[0];
    button(tip, "固定").listeners.click();
    app.run('document.listeners.keydown({key:"Escape"});');
    assert.equal(tip.hidden, true);
  }],
  ["image export includes standalone styling, metric group and full experiment identities", () => {
    const app = fixture();
    const svg = app.run('MiniCharts.exportSVG([{metric:"valid/sp",getSeries:()=>[...state.data.values()].map(data=>({run:data.run,points:seriesFor(data,"valid/sp")}))}],{axis:"step",axisLabel:"Step",smoothing:0},"valid_sp")');
    const labels = text(svg);
    assert(labels.includes("指标组：valid"));
    assert(labels.includes("A / MP_fold_0  [a]"));
    assert(labels.includes("A / MP_fold_1  [b]"));
    assert(labels.includes("valid / sp"));
    assert(Number(svg.getAttribute("height")) > 500);
    assert(all(svg, node => node.tag === "path").every(node => !!node.stroke));
    assert.equal(all(svg, node => node.className === "curve-tooltip").length, 0);
  }],
];
for (const [name, test] of tests) { test(); console.log("PASS", name); }
console.log(`${tests.length} chart checks passed`);
