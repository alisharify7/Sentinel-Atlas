'use strict';

class PageRefresh {
  static intervals=[1,5,10,15,30];

  constructor({page,scope,control,onRefresh,onIntervalChange,storage}) {
    this.key=`atlas:refresh:${scope}:${page}`;
    this.control=control;
    this.onRefresh=onRefresh;
    this.onIntervalChange=onIntervalChange;
    this.seconds=5;
    this.timer=null;
    this.active=false;
    this.busy=false;
    try {
      this.storage=storage||window.localStorage;
      const saved=Number(this.storage.getItem(this.key));
      if(PageRefresh.intervals.includes(saved))this.seconds=saved;
    } catch { /* Refresh controls also work when browser storage is unavailable. */ }
    if(control) {
      control.value=String(this.seconds);
      control.addEventListener('change',event=>this.setInterval(event.target.value));
    }
  }

  start() {
    if(this.timer!==null)clearInterval(this.timer);
    this.active=true;
    this.timer=setInterval(()=>this.refresh(),this.seconds*1000);
  }

  stop() {
    this.active=false;
    if(this.timer!==null)clearInterval(this.timer);
    this.timer=null;
  }

  setInterval(value) {
    const seconds=Number(value);
    if(!PageRefresh.intervals.includes(seconds)) {
      if(this.control)this.control.value=String(this.seconds);
      return false;
    }
    this.seconds=seconds;
    if(this.control)this.control.value=String(seconds);
    try {this.storage?.setItem(this.key,String(seconds));} catch { /* Keep the selection for this visit. */ }
    this.onIntervalChange?.(seconds);
    if(this.active){this.start();this.refresh();}
    return true;
  }

  async refresh() {
    if(!this.active||this.busy)return;
    this.busy=true;
    try {await this.onRefresh();}
    catch { /* Request handlers display connection errors; the next tick retries. */ }
    finally {this.busy=false;}
  }
}
