const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {dashboard} = require("./test_selection");
const assets=path.join(__dirname,"../miniwandb/static");
const html=fs.readFileSync(path.join(assets,"run.html"),"utf8");
const source=fs.readFileSync(path.join(assets,"run.js"),"utf8").replace(/\nrefresh\(\);\s*$/,"\n");
const run={id:"single",name:"<script>name</script>",project:"demo",status:"finished",config:{lr:0.001},summary:{"valid/sp":0.9},notes:"hello",tags:["test"],cv:null,created_at:1000,updated_at:1020,finished_at:1020,last_step:2};
function fixture() {
  const base=dashboard(), original=base.run("document");
  const nodes=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],original.createElement("div")]));
  const document={...original,getElementById(id){assert(nodes.has(id),id);return nodes.get(id);}};
  nodes.get("x-axis").value="step";nodes.get("smoothing").value="0";
  nodes.get("output-follow").checked=true;nodes.get("output-wrap").checked=true;
  const pre=nodes.get("output-text"),append=pre.append.bind(pre);
  pre.append=(...children)=>{append(...children);pre.textContent+=children.map(child=>child.textContent||"").join("");};
  const calls=[], outputPages=[{text:"start\n\u001b[31mred\u001b[0m\n<script>literal</script>\n",next:4,available:true,truncated:false,has_more:false}];
  const payload={run,metrics:["valid/sp"],history:[{step:0,timestamp:1000,metrics:{epoch:0,"valid/sp":0.8}},{step:2,timestamp:1020,metrics:{epoch:1,"valid/sp":0.9}}],evaluations:[{dataset:"test_a",name:"final",metrics:{sp:0.87},metadata:{checkpoint:"best"}}]};
  const fetch=async url=>{calls.push(url);let response;if(url.includes('/output'))response=outputPages.length?outputPages.shift():{text:"",next:4,available:true,truncated:false,has_more:false};else if(url.endsWith('/metadata'))response={run,evaluations:payload.evaluations};else response=payload;return {ok:true,json:async()=>response};};
  const context=vm.createContext({document,location:{pathname:"/runs/single",search:""},fetch,AbortController,URLSearchParams,console,setTimeout:()=>1,clearTimeout(){},setInterval(){}});
  for(const file of ["parameters.js","charts.js","reports.js"])vm.runInContext(fs.readFileSync(path.join(assets,file),"utf8"),context);
  vm.runInContext(source,context);
  return {nodes,calls,outputPages,payload,run:code=>vm.runInContext(code,context),value:code=>JSON.parse(vm.runInContext(`JSON.stringify(${code})`,context))};
}
async function main(){
  const tests=[
    ["single run loads metadata, metrics, parameters and separate evaluations",async()=>{
      const app=fixture();await app.run('refresh()');
      assert.equal(app.nodes.get('run-title').textContent,run.name);
      assert.equal(app.nodes.get('run-step').textContent,2);
      assert.equal(app.nodes.get('run-evaluations').children.length,1);
      assert(app.nodes.get('run-parameters').children.length);
      assert.equal(app.nodes.get('output-download').href,'/api/runs/single/output.log');
    }],
    ["live log updates use cursors without redownloading unchanged history",async()=>{
      const app=fixture();await app.run('refresh()');
      app.outputPages.push({text:'new line\n',next:5,available:true,truncated:false,has_more:false});
      await app.run('refresh()');
      assert.equal(app.calls.filter(url=>url==='/api/runs/single').length,1);
      assert(app.calls.includes('/api/runs/single/output?after=4'));
      assert(app.nodes.get('output-text').textContent.endsWith('new line\n'));
      assert(!app.nodes.get('output-text').textContent.includes('\u001b'));
      assert(app.nodes.get('output-text').textContent.includes('<script>literal</script>'));
    }],
    ["replacement resets old text and empty replacement clears the console",async()=>{
      const app=fixture();await app.run('refresh()');
      app.outputPages.push({text:'replacement\n',next:8,available:true,truncated:false,has_more:false,reset:true});
      await app.run('output()');assert.equal(app.nodes.get('output-text').textContent,'replacement\n');
      app.outputPages.push({text:'',next:0,available:false,truncated:false,has_more:false});
      await app.run('output()');assert.equal(app.nodes.get('output-text').textContent,'');
      assert(app.nodes.get('output-status').textContent.includes('尚无日志'));
    }],
    ["log window is bounded while raw source can be filtered and downloaded",async()=>{
      const app=fixture();await app.run('refresh()');
      app.outputPages.push({text:'x'.repeat(300000)+'\nneedle\n',next:9,available:true,truncated:false,has_more:false});
      await app.run('output()');assert.equal(app.run('logText.length'),262144);
      assert(app.nodes.get('output-status').textContent.includes('截取'));
      app.nodes.get('output-search').value='needle';app.run('displayOutput()');
      assert.equal(app.nodes.get('output-text').textContent,'needle');
    }],
    ["running metrics retain summary cards, collapsed evaluations and chart groups",async()=>{
      const app=fixture();await app.run('refresh()');
      const summary=app.nodes.get('run-summary-values').children[0],group=app.nodes.get('charts').children[0];
      app.nodes.get('run-evaluations').children[0].open=false;
      app.payload.run={...app.payload.run,summary:{'valid/sp':0.95},updated_at:1030,last_step:3};
      app.payload.history.push({step:3,timestamp:1030,metrics:{epoch:2,'valid/sp':0.95}});
      app.payload.evaluations=[{...app.payload.evaluations[0],metrics:{sp:0.9}}];
      // Exercise data delivery directly; the fixture's metadata response shares its original run object.
      app.run(`data=${JSON.stringify(app.payload)};charts(false);metadata();`);
      assert.equal(app.nodes.get('run-summary-values').children[0],summary);
      assert.equal(summary.children[1].textContent,'0.95');
      assert.equal(app.nodes.get('charts').children[0],group);
      assert.equal(app.nodes.get('run-evaluations').children[0].open,false);
    }],
  ];
  for(const [name,test]of tests){await test();console.log('PASS',name);}
  console.log(`${tests.length} single-run checks passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
