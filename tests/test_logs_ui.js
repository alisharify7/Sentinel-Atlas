'use strict';
// Exercise exported file bytes and the actual console controls without a browser.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const elements=new Map(),blobs=[],downloads=[],revoked=[],timers=[];
function element(id='') {
  const handlers={},classes=new Set();
  return {id,value:'',textContent:'',innerHTML:'',disabled:false,dataset:{},children:[],options:[],scrollTop:0,scrollHeight:100,
    classList:{add(name){classes.add(name);},remove(name){classes.delete(name);},toggle(name,on){if(on)classes.add(name);else classes.delete(name);},contains(name){return classes.has(name);}},
    setAttribute(name,value){this[name]=value;},
    addEventListener(type,handler){handlers[type]=handler;},
    dispatch(type){return handlers[type]?.({target:this});},
    querySelector(){return this.label||(this.label=element());},
    append(...children){this.children.push(...children);},
    replaceChildren(...children){this.children=children;this.options=children;},
    click(){downloads.push({filename:this.download,url:this.href});},
    remove(){this.removed=true;}
  };
}
for(const id of ['logNode','logFilter','logPause','logFollow','logOutput','logSource','logCount','logUpdated','logStatus','logDownload','logDownloadStatus'])elements.set(id,element(id));
const serviceButtons=['redis','sentinel'].map(service=>Object.assign(element(),{dataset:{logService:service}}));
const document={body:element('body'),getElementById:id=>elements.get(id)||null,createElement:()=>element(),createDocumentFragment:()=>element(),querySelectorAll:()=>serviceButtons};
const requests=[];
const fixtures={
  redis:{node:'cache-one',service:'redis',status:'ok',source:'/var/log/redis/redis.log',lines:['Ready to accept connections','WARNING sample café 🦉','error credential [REDACTED]'],updated_at:1793095200,poll_interval:5,stale:false},
  sentinel:{node:'cache-one',service:'sentinel',status:'ok',source:'journal · redis-sentinel.service',lines:['+monitor master redis-main','+switch-master redis-main'],updated_at:1793095200,poll_interval:5,stale:false}
};
const context=vm.createContext({document,Blob,AbortController,console,
  URL:{createObjectURL(blob){blobs.push(blob);return 'blob:test-'+blobs.length;},revokeObjectURL:url=>revoked.push(url)},
  setTimeout(callback){timers.push(callback);return timers.length;},clearTimeout(){},setInterval(){},
  Option:function(text,value){return {text,value};},
  apiFetch:async url=>{requests.push(url);return {ok:true,json:async()=>({...fixtures[url.includes('/sentinel?')?'sentinel':'redis']})};},
  renderGraph(){},renderSentinels(){},renderFleet(){},renderInspector(){},age:()=> 'just now'
});
const run=code=>vm.runInContext(code,context);
run("const $=id=>document.getElementById(id);let state={mode:'demo',nodes:[{name:'cache-one',metadata:{redis_port:6379,sentinel_port:26379}}]},selected='cache-one',activeCluster='main',scenario='healthy',accessLost=false;");
vm.runInContext(fs.readFileSync(path.join(__dirname,'../sentinel_atlas/static/log-export.js'),'utf8'),context);
const source=fs.readFileSync(path.join(__dirname,'../sentinel_atlas/static/app.js'),'utf8');
vm.runInContext(source.slice(source.indexOf("let logService='redis'")),context);

(async()=>{
  run('updateLogDownload()');
  assert.equal(elements.get('logDownload').disabled,true,'No file is offered before logs arrive');
  run('syncLogControls()');await run('fetchLogs(true)');
  assert.equal(elements.get('logDownload').disabled,false);
  const before=requests.length;
  elements.get('logDownload').dispatch('click');
  assert.equal(requests.length,before,'Downloads reuse the displayed observation without another connection');
  assert.equal(blobs.at(-1).type,'text/plain;charset=utf-8');
  let content=await blobs.at(-1).text();
  assert.match(content,/# Service: redis/);
  assert.match(content,/# Node: "cache-one"/);
  assert.match(content,/# Source: "\/var\/log\/redis\/redis.log"/);
  assert.match(content,/# Scope: latest collected tail \(up to 120 lines\); 3 of 3/);
  assert.match(content,/# Demo sample data/);
  assert.match(content,/WARNING sample café 🦉/,'Downloads preserve UTF-8 text');
  assert.match(content,/\[REDACTED\]/,'Credential redaction survives export');
  assert.match(downloads.at(-1).filename,/^cache-one-redis-.*\.log$/);
  assert.match(elements.get('logDownloadStatus').textContent,/Redis download ready · 3 lines/);

  elements.get('logFilter').value='WaRnInG';elements.get('logFilter').dispatch('input');
  elements.get('logDownload').dispatch('click');
  content=await blobs.at(-1).text();
  assert.match(content,/# Filter: "WaRnInG"/);
  assert.match(content,/# Scope: .*1 of 3 collected lines/);
  assert.equal(content.split('\n\n')[1],'WARNING sample café 🦉\n');
  assert.match(downloads.at(-1).filename,/-filtered\.log$/);
  elements.get('logFilter').value='no-matches';elements.get('logFilter').dispatch('input');
  assert.equal(elements.get('logDownload').disabled,true);
  assert.throws(()=>run('logExportSnapshot(logPayload,{filter:"no-matches"})'),/No log lines match/);

  elements.get('logFilter').value='';elements.get('logFilter').dispatch('input');
  elements.get('logPause').dispatch('click');
  fixtures.redis.lines=['NEW OBSERVATION'];
  const pausedRequests=requests.length;
  await run('fetchLogs()');
  elements.get('logDownload').dispatch('click');
  assert.equal(requests.length,pausedRequests);
  content=await blobs.at(-1).text();
  assert.match(content,/Ready to accept connections/,'Paused downloads preserve the paused observation');
  assert.doesNotMatch(content,/NEW OBSERVATION/);

  run("logService='sentinel';syncLogControls();");
  assert.equal(elements.get('logDownload').disabled,true,'Switching service cannot download the previous service');
  await run('fetchLogs(true)');
  elements.get('logDownload').dispatch('click');
  content=await blobs.at(-1).text();
  assert.match(content,/# Service: sentinel/);
  assert.match(content,/\+switch-master/);
  assert.doesNotMatch(content,/Ready to accept connections/);
  assert.match(downloads.at(-1).filename,/^cache-one-sentinel-/);
  assert.match(elements.get('logDownloadStatus').textContent,/Sentinel download ready/);

  run("logPayload={...logPayload,stale:true};renderLogs();");
  elements.get('logDownload').dispatch('click');
  assert.match(await blobs.at(-1).text(),/stale observation/,'Stale collected data can be downloaded with an explicit label');
  run("logPayload={...logPayload,node:'other-node'};updateLogDownload();downloadLogs();");
  assert.equal(elements.get('logDownload').disabled,true);
  assert.match(elements.get('logDownloadStatus').textContent,/selected instance and service/);
  run("logPayload={...logPayload,node:selected,status:'unsupported',lines:[]};renderLogs();");
  assert.equal(elements.get('logDownload').disabled,true,'Direct protocol monitoring cannot invent server log files');
  assert.throws(()=>run('logExportSnapshot(logPayload)'),/No collected log lines/);

  const safe=run("logExportSnapshot({...logPayload,node:'../cache:\\r\\nforged',service:'redis',lines:['literal <script>text</script>'],source:'file\\n# forged',stale:false},{now:new Date('2026-10-27T10:00:00Z')})");
  assert.match(safe.filename,/^cache-forged-redis-/);
  assert.doesNotMatch(safe.filename,/[\\/\r\n:]/);
  assert.match(safe.text,/# Source: "file\\n# forged"/);
  assert.match(safe.text,/literal <script>text<\/script>/,'Log content stays plaintext');
  assert.doesNotMatch(safe.text,/# Demo sample data/);
  assert.match(safe.text,/# Downloaded at \(UTC\): 2026-10-27T10:00:00.000Z/);
  const failures=downloads.length;
  run('accessLost=true;updateLogDownload();downloadLogs();');
  assert.equal(elements.get('logDownload').disabled,true);
  assert.equal(downloads.length,failures,'An unavailable viewing link cannot start another download');
  timers.forEach(callback=>callback());
  assert.equal(revoked.length,blobs.length,'Object URLs are released after downloads');
  console.log('Log UI checks passed: Redis/Sentinel exports, UTF-8 file bytes, filtering, paused snapshots, stale data, service switching, unavailable logs, filenames, and URL cleanup.');
})().catch(error=>{console.error(error);process.exitCode=1;});
