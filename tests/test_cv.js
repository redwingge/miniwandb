const assert = require("node:assert/strict");
const {dashboard} = require("./test_selection");

function all(root, predicate) { const result=[]; function visit(node) { if(predicate(node))result.push(node); for(const child of node.children||[])visit(child); } visit(root);return result; }
function metadata() {
  const cv = (id, fold, name="CV A") => ({group_id:id,fold,preferred:0,name,n_splits:3,project:"RBP",origin:"config"});
  const make = (id, created, status, group, config={}) => ({id,name:id,project:"RBP",status,created_at:created,updated_at:2000,last_step:5,notes:"",tags:[],summary:{"valid/mcc":0.5},config:{seed:42,...config},cv:group});
  return [make("a-old",1000,"finished",cv("group-a",0),{fold:0,lora_lr:0.0001,model_type:"0_3fold"}),
    make("a-failed",1002,"failed",cv("group-a",0),{fold:0,lora_lr:0.0001,model_type:"0_3fold"}),
    make("a-fold1",1001,"finished",cv("group-a",1),{fold:1,lora_lr:0.0002,model_type:"1_3fold"}),
    make("b-fold0",1003,"finished",cv("group-b",0,"CV B"),{fold:0,lora_lr:0.001,model_type:"0_3fold"}),
    make("plain",1004,"finished",null,{lora_lr:0.002})];
}
function fixture(fetch) {
  const app=dashboard({fetch:fetch|| (async()=>({ok:true,json:async()=>({metric:"valid/mcc",reduction:"max",groups:[]})}))});
  app.run(`state.runs=${JSON.stringify(metadata())};state.initial=false;document.getElementById("run-layout").value="groups";renderRuns();`);
  return app;
}

async function main(){
 const tests=[
  ["representatives prefer successful attempts rather than newer failures",()=>{
    const app=fixture();
    assert.deepEqual(app.value('MiniCV.representatives(MiniCV.groups(state.runs)[0]).map(run=>run.id)'),["a-old","a-fold1"]);
    app.run('state.runs[0].cv.preferred=1;');
    assert.equal(app.run('MiniCV.representative(state.runs.filter(run=>run.cv?.group_id==="group-a"&&run.cv.fold===0)).id'),"a-old");
  }],
  ["fold hierarchy retains every attempt and marks missing folds",()=>{
    const app=fixture(),list=app.nodes.get("runs");
    assert.equal(list.children.length,3);
    assert.equal(all(list,node=>node.className==="cv-attempt").length,4);
    assert(all(list,node=>node.className==="cv-fold-empty").some(node=>node.textContent.includes("未运行")));
    const checkbox=list.children[0].children[0].children[0];checkbox.checked=true;checkbox.listeners.change();
    assert.deepEqual(app.value('[...state.selected].sort()'),["a-fold1","a-old"]);
  }],
  ["group parameter comparison exposes internal variations and keeps independent runs",()=>{
    const app=fixture();app.run('state.selected=new Set(["a-old","a-fold1","b-fold0","plain"]);document.getElementById("comparison-layout").value="groups";renderComparison();');
    const group=app.value('MiniCV.parameterRuns(selectedMetadata())[0]');
    const values=new Map(group.comparisonValues);
    assert.equal(values.get("lora_lr").__miniwandb_cv_variation,true);
    assert.equal(values.get("seed"),42);
    assert.equal(values.get("model_type"),"{fold}_3fold");
    assert(!values.has("fold"));
    assert.equal(app.run('MiniCV.parameterRuns(selectedMetadata()).length'),3);
    assert(all(app.nodes.get("comparison-table"),node=>node.className==="parameter-value").some(node=>node.textContent==="组内差异"&&node.title.includes("fold 1")));
  }],
  ["summary requests are cached and expose the exact aggregation method",async()=>{
    const calls=[];const app=fixture(async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({metric:"valid/mcc",reduction:"max",groups:[{id:"group-a",name:"CV A",project:"RBP",completed:2,n_splits:3,n:2,mean:0.5,std:0.1,min:0.4,max:0.6,folds:[]}]})};});
    app.run('state.selected=new Set(["a-old"]);MiniCV.update();');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,1);assert.equal(calls[0].url,"/api/cv/summary");
    assert.equal(calls[0].body.reduction,"max");assert.deepEqual(calls[0].body.group_ids,["group-a"]);
    assert.equal(app.nodes.get("cv-export-summary").disabled,false);
    app.run('MiniCV.update();');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1);
  }],
  ["CV comparison defaults to saved test scores and switches back to history explicitly",async()=>{
    const calls=[];
    const app=fixture(async(url,options)=>{
      const body=JSON.parse(options.body);calls.push({url,body});
      return {ok:true,json:async()=>({...body,groups:[]})};
    });
    app.run(`state.runs[0].evaluation_keys=[{dataset:"test_a",name:"last",metrics:["mcc"]},{dataset:"test_a",name:"final",metrics:["mcc","sp"]},{dataset:"test_b",name:"final",metrics:["AP"]}];
      state.selected=new Set(["a-old"]);MiniCV.update();`);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls[0].body.source,"evaluation");
    assert.equal(calls[0].body.dataset,"test_a");assert.equal(calls[0].body.evaluation,"final");
    assert.equal(calls[0].body.metric,"mcc");assert.equal(calls[0].body.reduction,"final");
    assert.equal(app.nodes.get("cv-reduction").disabled,true);
    assert.equal(app.nodes.get("cv-dataset-field").hidden,false);
    assert.equal(app.run("MiniCV.analysisMetric()"),"");
    app.nodes.get("cv-evaluation").value="last";app.run("MiniCV.update();");
    await new Promise(resolve=>setImmediate(resolve));assert.equal(calls[1].body.evaluation,"last");
    app.nodes.get("cv-dataset").value="test_b";app.run("MiniCV.update();");
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls[2].body.dataset,"test_b");assert.equal(calls[2].body.evaluation,"final");assert.equal(calls[2].body.metric,"AP");
    app.nodes.get("cv-source").value="history";app.run("MiniCV.update();");
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls[3].body.source,"history");assert.equal(calls[3].body.metric,"valid/mcc");
    assert.equal(app.nodes.get("cv-dataset-field").hidden,true);
    assert.equal(app.nodes.get("cv-reduction").disabled,false);
  }],
  ["late final score changes refresh CV values without a training history change",async()=>{
    const calls=[];const app=fixture(async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);return {ok:true,json:async()=>({...body,groups:[]})};});
    app.run('state.runs[0].evaluation_keys=[{dataset:"test",name:"final",metrics:["mcc"]}];state.runs[0].evaluations_updated_at=1;state.selected=new Set(["a-old"]);MiniCV.update();');
    await new Promise(resolve=>setImmediate(resolve));
    app.run('MiniCV.update();');assert.equal(calls.length,1);
    app.run('state.runs[0].evaluations_updated_at=2;MiniCV.update();');
    await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,2);
    assert.equal(calls[1].source,"evaluation");
  }],
  ["an empty final selection invalidates a pending history summary",async()=>{
    let resolveRequest;
    const app=fixture(async()=>new Promise(resolve=>{resolveRequest=resolve;}));
    app.run('state.selected=new Set(["a-old"]);MiniCV.update();');
    app.nodes.get("cv-source").value="evaluation";app.run("MiniCV.update();");
    resolveRequest({ok:true,json:async()=>({source:"history",metric:"valid/mcc",reduction:"max",groups:[]})});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(app.nodes.get("cv-summary-table").children.length,0);
    assert.equal(app.nodes.get("cv-export-summary").disabled,true);
    assert(app.nodes.get("cv-summary-status").textContent.includes("尚无最终评估"));
  }],
  ["manual grouping previews before saving and sends reviewed fold assignments",async()=>{
    const calls=[];const app=fixture(async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});return {ok:true,json:async()=>url.endsWith("preview")?{runs:[{id:"plain",name:"plain",project:"RBP",fold:0,n_splits:3,group_id:null,warnings:[]}],candidates:[]}:{group_id:"new",updated:1}};});
    app.run('state.selected=new Set(["plain"]);renderRuns();');
    await app.click("cv-manual-group");assert.equal(calls.length,1);assert.equal(app.nodes.get("cv-dialog").open,true);
    app.nodes.get("cv-group-name").value="Reviewed CV";
    await app.click("cv-dialog-confirm");
    assert.equal(calls[1].url,"/api/cv/assign");assert.equal(calls[1].body.confirm,true);
    assert.deepEqual(calls[1].body.folds,{plain:0});assert.equal(calls[1].body.allow_move,false);
  }],
  ["running batches do not clear CV tables and background replacement preserves fold expansion",async()=>{
    let waiting=null,calls=0;
    const payload={metric:'valid/mcc',reduction:'max',groups:[{id:'group-a',name:'CV A',project:'RBP',completed:1,n_splits:3,n:1,mean:0.5,std:null,min:0.5,max:0.5,folds:[]}]};
    const app=fixture(async()=>{calls++;if(calls===1)return {ok:true,json:async()=>payload};return await new Promise(resolve=>{waiting=()=>resolve({ok:true,json:async()=>({...payload,groups:[{...payload.groups[0],mean:0.6}]})});});});
    app.run('state.runs[1].status="running";state.selected=new Set(["a-old"]);MiniCV.update();');
    await new Promise(resolve=>setImmediate(resolve));
    const holder=app.nodes.get('cv-summary-table'),table=holder.children[0];holder.children[1].open=true;
    app.run('state.runs[1].updated_at++;state.runs[1].last_step++;MiniCV.update();');
    await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(holder.children[0],table);
    app.run('state.runs[0].updated_at++;MiniCV.update();');
    assert.equal(holder.children[0],table,'keep previous table during network request');
    await new Promise(resolve=>setImmediate(resolve));waiting();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(holder.children[1].open,true);
  }],
  ["legacy grouping never auto-applies candidates and blocks ambiguous groups",async()=>{
    const calls=[];const app=fixture(async(url,options)=>{calls.push(url);return {ok:true,json:async()=>({runs:[],candidates:[{id:"blocked",name:"ambiguous",project:"RBP",n_splits:3,blocked:true,warnings:["fold 冲突"],config:{seed:42},runs:[]}]})};});
    await app.click("cv-auto-group");
    assert.equal(calls.length,1);assert.equal(calls[0],"/api/cv/preview");
    assert.equal(all(app.nodes.get("cv-dialog-items"),node=>node.tag==="input")[0].disabled,true);
    app.click("cv-dialog-cancel");assert.equal(calls.length,1);
  }],
  ["flat mode continues to display every original experiment",()=>{
    const app=fixture();app.nodes.get("run-layout").value="flat";app.run('renderRuns();');
    assert.equal(app.nodes.get("runs").children.length,5);
    assert(app.nodes.get("runs").children.every(node=>node.className.includes("run-row")));
  }],
 ];
 for(const [name,test]of tests){await test();console.log("PASS",name);}console.log(`${tests.length} CV interaction checks passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
