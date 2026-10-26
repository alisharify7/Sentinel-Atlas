'use strict';
// Dependency-free checks for topology layout and node inspection behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const elements = new Map();
const listeners = {};
function element(id) {
  return {id, dataset:{}, style:{}, clientWidth:800, children:[], scrollTop:0, _html:'', textContent:'',
    get innerHTML() { return this._html; },
    set innerHTML(value) {
      this._html=value;
      this.children=[...value.matchAll(/<button\b([^>]+)>/g)].map(match=>{
        const child=element('button');
        for (const attr of match[1].matchAll(/data-([\w-]+)="([^"]*)"/g)) {
          child.dataset[attr[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=attr[2];
        }
        return child;
      });
      if (id==='inspector') {
        for (const child of ['configRows','configCount','configSearch']) elements.delete(child);
        for (const match of value.matchAll(/id="([^"]+)"/g)) elements.set(match[1],element(match[1]));
      }
    },
    contains(target) { return this.children.includes(target); },
    querySelectorAll(selector) { return this.children.filter(child=>selector==='[data-node]'?child.dataset.node:child.dataset.tab); },
    setAttribute(name,value) { this[name]=value; },
    focus() { document.activeElement=this; },
    setSelectionRange(start,end) { this.selectionStart=start;this.selectionEnd=end; },
    scrollIntoView() { this.scrolled=true; }
  };
}
const document={activeElement:null,getElementById:id=>elements.get(id)||null,addEventListener:(kind,fn)=>listeners[kind]=fn};
for (const id of ['inspector','graphContainer','graphEmpty','graphNodes','graphLines','topologyStats','sentinelNetwork','fleetBody']) elements.set(id,element(id));
let mobile=false;
const context=vm.createContext({document,Intl,console,window:{matchMedia:()=>({matches:mobile})}});
const source=fs.readFileSync(path.join(__dirname,'../sentinel_atlas/static/app.js'),'utf8');
const clickStart=source.indexOf("document.addEventListener('click'");
vm.runInContext(source.slice(0,clickStart),context);
vm.runInContext('syncLogControls=()=>{};',context);
vm.runInContext(source.slice(clickStart,source.indexOf("document.addEventListener('keydown'")),context);
const run=code=>vm.runInContext(code,context);
const node=(name,role)=>({name,metadata:{name,cluster:'main',redis_member:true,sentinel_member:true,address:name,redis_port:6379,sentinel_port:26379,deployment:'direct'},redis:{up:true,role,upstream:role==='replica'?'primary':null,upstream_port:6379,link:'up',config_status:'ok',configuration:{timeout:name==='primary'?'10':'20',save:''}},sentinel:{up:true,quorum_ok:true,master_ip:'primary',master_port:6379,required_quorum:2,other_sentinels:2,known_replicas:2,flags:'master'},history:[],hardware:{},container:{},storage:[]});
const initial={master:'primary',summary:{redis_up:3,redis_total:3,ops:1200,memory:1024,consensus:true},nodes:[node('primary','master'),node('replica-a','replica'),node('replica-b','replica')]};
const reset=()=>{document.activeElement=null;run(`state=${JSON.stringify(initial)};selected='primary';selectedTab='overview';configFilter='';`);};
function assertLayout(width) {
  elements.get('graphContainer').clientWidth=width;
  run('renderGraph()');
  const boxes=[...elements.get('graphNodes').innerHTML.matchAll(/style="left:([\d.-]+)px;top:([\d.-]+)px;width:([\d.-]+)px"/g)].map(m=>({x:+m[1],y:+m[2],w:+m[3],h:236}));
  assert.equal(boxes.length,3);
  for (const box of boxes) {
    assert.ok(box.x>=0 && box.x+box.w<=width);
    assert.ok(box.y+box.h<=parseFloat(elements.get('graphContainer').style.height));
  }
  boxes.forEach((a,i)=>boxes.slice(i+1).forEach(b=>assert.ok(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y,'Node cards must not overlap')));
}
const click=async (name,tab)=>listeners.click({target:{closest:selector=>selector==='[data-node]'?{dataset:{node:name,...(tab?{inspectTab:tab}:{})}}:null}});
(async()=>{
  reset();
  run("state.nodes.forEach(n=>n.replication={state:n.redis.role==='master'?'master':'in_sync',lag_bytes:n.redis.role==='master'?null:0,progress_percent:null});renderGraph();renderFleet();");
  assert.match(elements.get('graphNodes').innerHTML,/In sync/);
  assert.match(elements.get('fleetBody').innerHTML,/0 B sampled gap/);
  run("state.nodes[1].replication={state:'catching_up',lag_bytes:65536,progress_percent:null};renderGraph();renderFleet();");
  assert.match(elements.get('graphNodes').innerHTML,/Catching up/);
  assert.match(elements.get('fleetBody').innerHTML,/64 KiB sampled gap/);
  run("state.nodes[1].replication={state:'syncing',lag_bytes:null,progress_percent:45};renderGraph();");
  assert.match(elements.get('graphNodes').innerHTML,/45.0% transferred/);
  assert.match(elements.get('graphNodes').innerHTML,/aria-valuenow="45"/);
  run("state.nodes[1].replication.progress_percent=null;renderGraph();");
  assert.doesNotMatch(elements.get('graphNodes').innerHTML,/aria-valuenow/);
  run("state.nodes[1].replication.state='link_down';renderFleet();selected='replica-a';selectedTab='overview';renderInspector();");
  assert.match(elements.get('fleetBody').innerHTML,/Link down/);
  assert.match(elements.get('inspector').innerHTML,/LIVE REPLICATION/);
  reset();
  for (const width of [220,300,520,800,1140]) assertLayout(width);
  assert.equal((elements.get('graphLines').innerHTML.match(/class="edge /g)||[]).length,2);
  run('renderSentinels()');
  assert.match(elements.get('sentinelNetwork').innerHTML,/Consensus reached/);
  assert.equal(elements.get('sentinelNetwork').children.length,3);
  run("state.nodes[1].sentinel.master_ip='other';state.summary.consensus=false;renderSentinels();");
  assert.match(elements.get('sentinelNetwork').innerHTML,/Master view differs/);
  run('state.nodes[1].sentinel.quorum_ok=false;renderSentinels();');
  assert.match(elements.get('sentinelNetwork').innerHTML,/No quorum/);
  run('state.nodes[1].sentinel.up=false;renderSentinels();');
  assert.match(elements.get('sentinelNetwork').innerHTML,/Unavailable/);
  reset();
  await click('replica-a');
  assert.match(elements.get('inspector').innerHTML,/RUNTIME CONFIGURATION/);
  assert.match(elements.get('configRows').innerHTML,/>20</);
  listeners.input({target:{id:'configSearch',value:'TIMEOUT'}});
  assert.equal(elements.get('configCount').textContent,'1 of 2 settings');
  await click('primary','sentinel');
  assert.match(elements.get('inspector').innerHTML,/SENTINEL MONITOR/);
  assert.match(elements.get('inspector').innerHTML,/data-copy="primary:26379"/);
  mobile=true;
  await click('primary');
  assert.equal(elements.get('inspector').scrolled,true);
  mobile=false;
  // Sentinel-only hosts are monitors, never Redis replication nodes.
  run("state.nodes.push({...state.nodes[0],name:'observer',metadata:{...state.nodes[0].metadata,redis_member:false,sentinel_address:'watcher'},redis:{up:false}});renderGraph();renderSentinels();");
  assert.equal(elements.get('graphNodes').children.length,3);
  assert.equal(elements.get('sentinelNetwork').children.length,4);
  await click('observer','sentinel');
  assert.match(elements.get('inspector').innerHTML,/data-copy="watcher:26379"/);
  assert.doesNotMatch(elements.get('inspector').innerHTML,/Redis is unavailable/);
  // Outages must not invent an upstream relationship.
  reset();
  run("state.nodes[1].redis={up:false};renderGraph();");
  assert.equal((elements.get('graphLines').innerHTML.match(/class="edge /g)||[]).length,1);
  run('state.nodes.forEach(n=>n.metadata.sentinel_member=false);renderSentinels();');
  assert.match(elements.get('sentinelNetwork').innerHTML,/Not configured/);
  run('state.nodes=[];renderGraph();renderInspector();');
  assert.equal(elements.get('graphNodes').children.length,0);
  assert.match(elements.get('inspector').innerHTML,/Inspect an instance/);
  console.log('UI checks passed: responsive graph geometry, Sentinel consensus/failures, configuration selection/search, Sentinel endpoint, mobile navigation, and observed replication links.');
})().catch(error=>{console.error(error);process.exitCode=1;});
