const assert = require("node:assert/strict");
const {dashboard} = require("./test_selection");

function all(root, predicate) {
  const result = [];
  function visit(node) { if (predicate(node)) result.push(node); for (const child of node.children || []) visit(child); }
  visit(root); return result;
}
function texts(root) { return all(root, node => !!node.textContent).map(node => node.textContent).join("\n"); }
const models = [
  {id:"cv-a", name:"MP_lr_5e-5", project:"RBP", n_splits:5, records:[0.6,0.7,0.8].flatMap((value,fold) => [
    {run_id:`a${fold}`, run_name:`MP_fold_${fold}`, fold, dataset:"test_1580", name:"final", metrics:{mcc:value,sp:value+0.1}, metadata:{checkpoint:"best.pth"}},
    {run_id:`a${fold}`, run_name:`MP_fold_${fold}`, fold, dataset:"test_46541", name:"final", metrics:{mcc:value-0.2}, metadata:{}},
    {run_id:`a${fold}`, run_name:`MP_fold_${fold}`, fold, dataset:"test_1580", name:"last", metrics:{mcc:0.1}, metadata:{}},
  ])},
  {id:"cv-b", name:"MAP_lr_1e-4", project:"RBP", n_splits:5, records:[
    {run_id:"b0",run_name:"MAP_fold_0",fold:0,dataset:"test_1580",name:"final",metrics:{mcc:0.9},metadata:{}},
    {run_id:"b1",run_name:"MAP_fold_1",fold:1,dataset:"test_1580",name:"final",metrics:{mcc:null},metadata:{}},
  ]},
];
function fixture() {
  const calls=[];
  const app = dashboard({evaluations:true, fetch:async (url, options) => {
    calls.push({url,body:JSON.parse(options.body)});
    return {ok:true,json:async()=>({models})};
  }});
  app.nodes.get("evaluation-plot").value="box";
  app.run('state.runs=[{id:"a0",status:"finished",evaluations_updated_at:1}];state.selected=new Set(["a0"]);');
  return {...app,calls};
}
async function main() {
  const tests=[
    ["sample standard deviation, interpolated quartiles and Tukey whiskers use actual finite scores",()=>{
      const app=fixture(), result=app.value('MiniEvaluations.statistics([0,1,2,3,100,null])');
      assert.equal(result.n,5); assert.equal(result.mean,21.2); assert.equal(result.q1,1); assert.equal(result.median,2);
      assert.equal(result.q3,3); assert.equal(result.low,0); assert.equal(result.high,3);
      assert(Math.abs(app.value('MiniEvaluations.statistics([0.6,0.7,0.8]).std')-0.1)<1e-12);
      assert.equal(app.value('MiniEvaluations.statistics([0.9]).std'),null);
      assert.equal(app.value('MiniEvaluations.statistics([]).mean'),null);
    }],
    ["datasets and evaluation versions stay separate and missing folds never become zeros",async()=>{
      const app=fixture(); await app.run('MiniEvaluations.update()');
      const a=app.value('MiniEvaluations.series("test_1580","mcc","final")[0]');
      assert.equal(a.stats.n,3); assert(Math.abs(a.stats.mean-0.7)<1e-12); assert.equal(a.n_splits,5);
      assert.equal(app.value('MiniEvaluations.series("test_1580","mcc","final")[1].stats.n'),1);
      assert.equal(app.value('MiniEvaluations.series("test_46541","mcc","final")[1].stats.n'),0);
      assert.equal(app.value('MiniEvaluations.series("test_1580","mcc","last")[0].stats.mean'),0.1);
      assert.equal(app.nodes.get("evaluation-charts").children.length,2);
    }],
    ["box and bar plots retain fold dots, missing groups, full legends and single-point semantics",async()=>{
      const app=fixture(); await app.run('MiniEvaluations.update()');
      for (const kind of ["box","bar"]) {
        const svg=app.run(`MiniEvaluations.plot("test_1580","mcc","final",MiniEvaluations.series("test_1580","mcc","final"),"${kind}")`);
        assert.equal(all(svg,node=>node.tag==="circle").length,4);
        assert(texts(svg).includes("n=1/5 · 单点")); assert(texts(svg).includes("RBP / MP_lr_5e-5 [cv-a]"));
        assert(!JSON.stringify(svg).includes('"cy":null'));
      }
      const svg=app.run('MiniEvaluations.plot("test_46541","mcc","final",MiniEvaluations.series("test_46541","mcc","final"),"box")');
      assert(texts(svg).includes("缺失结果"));
    }],
    ["final evaluation revisions refresh comparison without downloading training history",async()=>{
      const app=fixture(); await app.run('MiniEvaluations.update()'); await app.run('MiniEvaluations.update()');
      assert.equal(app.calls.length,1); assert.equal(app.calls[0].url,"/api/evaluations/compare");
      await app.run('state.runs[0].evaluations_updated_at=2;MiniEvaluations.update()'); assert.equal(app.calls.length,2);
      await app.run('state.selected.clear();MiniEvaluations.update()');
      assert.equal(app.nodes.get("evaluation-charts").children.length,0);
      assert.equal(app.nodes.get("evaluation-export").disabled,true);
    }],
    ["CSV includes group identity, dataset, fold values, checkpoint metadata and exact summary",async()=>{
      const app=fixture(); await app.run('MiniEvaluations.update()');
      const csv=app.run('MiniEvaluations.csv()');
      assert(csv.includes('"std_ddof1"')); assert(csv.includes('"test_1580"')); assert(csv.includes('"test_46541"'));
      assert(csv.includes('"a0"')); assert(csv.includes('best.pth')); assert(!csv.includes('"last"'));
    }],
    ["late responses cannot restore plots for a previous selection",async()=>{
      const app=dashboard({evaluations:true,fetch:()=>new Promise(resolve=>{app.resolve=resolve;})});
      app.run('state.runs=[{id:"a"}];state.selected=new Set(["a"]);'); const pending=app.run('MiniEvaluations.update()');
      await app.run('state.selected.clear();MiniEvaluations.update()');
      app.resolve({ok:true,json:async()=>({models})}); await pending;
      assert.equal(app.nodes.get("evaluation-charts").children.length,0);
      assert.equal(app.nodes.get("evaluation-status").textContent,"勾选实验后查看最终评估");
    }],
    ["background metadata changes keep final charts and collapsed datasets",async()=>{
      const app=fixture();await app.run('MiniEvaluations.update()');
      const first=app.nodes.get('evaluation-charts').children[0];first.open=false;
      await app.run('state.runs[0].evaluations_updated_at=2;MiniEvaluations.update()');
      assert.equal(app.nodes.get('evaluation-charts').children[0],first);
      assert.equal(first.open,false);
      app.run('document.getElementById("evaluation-plot").value="bar";document.getElementById("evaluation-plot").listeners.change();');
      assert.equal(app.nodes.get('evaluation-charts').children[0].open,false);
    }],
  ];
  for (const [name,test] of tests) {await test();console.log("PASS",name);}
  console.log(`${tests.length} final evaluation checks passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
