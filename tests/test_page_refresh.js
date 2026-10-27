'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const stored=new Map(),timers=new Map(),cleared=[];
let timerId=0;
const storage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)};
const context=vm.createContext({window:{localStorage:storage},
  setInterval(callback,ms){const id=++timerId;timers.set(id,{callback,ms});return id;},
  clearInterval(id){cleared.push(id);timers.delete(id);}
});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../sentinel_atlas/static/page-refresh.js'),'utf8'),context);
const PageRefresh=vm.runInContext('PageRefresh',context);
function control() {
  return {value:'',addEventListener(type,handler){this[type]=handler;},changeTo(value){this.value=value;this.change({target:this});}};
}

(async()=>{
  let requests=0,changed=0;
  const select=control();
  const page=new PageRefresh({page:'live',scope:'user-1',control:select,onRefresh:async()=>{requests++;},onIntervalChange:()=>{changed++;}});
  assert.equal(page.seconds,5);assert.equal(select.value,'5');
  page.start();
  assert.equal(timers.size,1);
  assert.equal(timers.get(page.timer).ms,5000);
  for(const seconds of [1,5,10,15,30]) {
    const old=page.timer;
    select.changeTo(String(seconds));
    await new Promise(setImmediate);
    assert.equal(page.seconds,seconds);
    assert.equal(timers.get(page.timer).ms,seconds*1000);
    assert.equal(timers.size,1,'Changing the interval replaces the old timer');
    assert.ok(cleared.includes(old));
    assert.equal(stored.get('atlas:refresh:user-1:live'),String(seconds));
  }
  assert.equal(changed,5);assert.equal(requests,5,'A new interval immediately checks for updates');
  const before=page.timer;
  for(const bad of ['bad','',0,2,3,60,Infinity])assert.equal(page.setInterval(bad),false);
  assert.equal(page.timer,before);
  assert.equal(page.seconds,30);assert.equal(select.value,'30');
  const reloaded=new PageRefresh({page:'live',scope:'user-1',control:control(),onRefresh:()=>{}});
  assert.equal(reloaded.seconds,30,'Reloading a page restores its setting');
  const logs=new PageRefresh({page:'logs',scope:'user-1',onRefresh:()=>{}});
  const account=new PageRefresh({page:'live',scope:'user-2',onRefresh:()=>{}});
  const shared=new PageRefresh({page:'live',scope:'share-1',onRefresh:()=>{}});
  assert.equal(logs.seconds,5,'Different pages have independent settings');
  assert.equal(account.seconds,5,'Accounts have independent settings');
  assert.equal(shared.seconds,5,'Shared views have independent settings');
  logs.setInterval(10);shared.setInterval(15);
  assert.equal(stored.get('atlas:refresh:user-1:live'),'30');
  assert.equal(stored.get('atlas:refresh:user-1:logs'),'10');
  assert.equal(stored.get('atlas:refresh:share-1:live'),'15');

  let finish,slowRequests=0;
  const slow=new PageRefresh({page:'instances',scope:'user-1',onRefresh:()=>{slowRequests++;return new Promise(resolve=>{finish=resolve;});}});
  slow.start();
  const pending=slow.refresh();
  await slow.refresh();await timers.get(slow.timer).callback();
  slow.setInterval(1);
  assert.equal(slowRequests,1,'Slow requests do not overlap, even when changing intervals');
  assert.equal(timers.get(slow.timer).ms,1000);
  finish();await pending;
  const next=slow.refresh();assert.equal(slowRequests,2);finish();await next;
  slow.stop();await slow.refresh();
  assert.equal(slowRequests,2,'Stopped pages cannot start another request');
  assert.equal(slow.timer,null);

  let attempts=0;
  const retry=new PageRefresh({page:'activity',scope:'user-1',onRefresh:async()=>{attempts++;throw Error('Offline');}});
  retry.start();await retry.refresh();await retry.refresh();
  assert.equal(attempts,2,'A failed refresh releases the request guard for the next tick');
  const blocked={getItem(){throw Error('Storage blocked');},setItem(){throw Error('Storage blocked');}};
  const privatePage=new PageRefresh({page:'live',scope:'private',storage:blocked,onRefresh:()=>{}});
  assert.equal(privatePage.seconds,5);assert.equal(privatePage.setInterval(1),true);assert.equal(privatePage.seconds,1);
  stored.set('atlas:refresh:user-3:live','invalid');
  assert.equal(new PageRefresh({page:'live',scope:'user-3',onRefresh:()=>{}}).seconds,5);
  for(const controller of [page,logs,account,shared,retry,privatePage])controller.stop();
  assert.equal(timers.size,0);
  console.log('Page refresh checks passed: all intervals, persistence, page/account/share isolation, timer replacement, slow requests, retries, and unavailable storage.');
})().catch(error=>{console.error(error);process.exitCode=1;});
