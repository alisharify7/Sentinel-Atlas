'use strict';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = (name, cls='') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const fmt = n => Number.isFinite(Number(n)) ? new Intl.NumberFormat(undefined, {maximumFractionDigits: 0}).format(n) : '—';
function bytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  if (n < 1024) return `${fmt(n)} B`;
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024**i).toFixed(i > 1 ? 1 : 0)} ${['B','KiB','MiB','GiB'][i]}`;
}
function age(timestamp) {
  if (!timestamp) return 'never observed';
  const seconds = Math.max(0, Math.floor(Date.now()/1000 - timestamp));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`;
  return `${Math.floor(seconds/3600)}h ago`;
}
function uptime(seconds) {
  if (seconds == null) return '—';
  return seconds >= 86400 ? `${Math.floor(seconds/86400)}d ${Math.floor(seconds%86400/3600)}h` : seconds >= 3600 ? `${Math.floor(seconds/3600)}h ${Math.floor(seconds%3600/60)}m` : `${Math.floor(seconds/60)}m`;
}
const percent = (used, total) => total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : 0;
const endpoint = n => `${n.metadata.address || n.name}:${n.metadata.redis_port || '—'}`;
const online = n => n.metadata.redis_member ? !!n.redis.up : !!n.sentinel.up;
const role = n => !online(n) ? 'down' : n.metadata.redis_member ? ['master','replica'].includes(n.redis.role) ? n.redis.role : 'unknown' : 'sentinel';
const badge = n => `<span class="role-badge ${role(n)}">${role(n) === 'down' ? 'unavailable' : esc(role(n))}</span>`;
const detail = (label, value, mono=false) => `<div class="detail-row"><span>${esc(label)}</span><strong class="${mono?'mono':''}">${esc(value ?? '—')}</strong></div>`;
function meter(label, value, total) {
  const p = percent(value,total);
  return `<div class="metric-label"><span>${esc(label)}</span><strong>${bytes(value)} / ${bytes(total)}</strong></div><div class="meter"><span class="${p>90?'danger':p>75?'warn':''}" style="width:${p}%"></span></div>`;
}
let state = null, selected = null, selectedTab = 'overview', scenario = 'healthy', activeCluster='', lastRender = null, serverConnected = false;

async function apiFetch(url, options) {
  const response=await fetch(url,options);
  if(response.status===401){location.assign('/login?next='+encodeURIComponent(location.pathname));throw Error('Login required');}
  return response;
}

function render(data) {
  state = data;
  activeCluster=data.cluster;
  const clusterSelect=$('clusterSelect'), clusters=data.clusters || [data.cluster];
  if([...clusterSelect.options].map(option=>option.value).join('|')!==clusters.join('|'))clusterSelect.replaceChildren(...clusters.map(name=>new Option(name,name)));
  clusterSelect.value=activeCluster;clusterSelect.hidden=clusters.length<2;
  const s = data.summary;
  const master = data.nodes.find(n => n.name === data.master);
  $('demoControls').hidden = data.mode !== 'demo';
  const health = {healthy:'Healthy', degraded:'Degraded', offline:'Offline', loading:'Discovering'}[data.status] || 'Unknown';
  $('healthValue').innerHTML = `${health}<span class="dot ${data.status==='healthy'?'':data.status==='loading'?'muted':data.status==='degraded'?'amber':'red'}"></span>`;
  $('healthFoot').textContent = data.status==='healthy' ? 'All instances reporting normally' : data.status==='loading' ? 'Reading inventory and connecting' : data.master_count>1 ? 'Multiple masters observed' : !data.master ? 'No current master observed' : 'Some instances need attention';
  $('redisUp').textContent = s.redis_up;
  $('redisTotal').textContent = `/ ${s.redis_total}`;
  $('redisFoot').textContent = `${s.replicas} replica${s.replicas===1?'':'s'} · ${s.clients} connected clients`;
  $('quorumReady').textContent = s.quorum_ready;
  $('sentinelTotal').textContent = `/ ${s.sentinel_total}`;
  $('quorumFoot').textContent = s.consensus ? 'In agreement on the current master' : s.sentinel_total ? 'Waiting for consensus' : 'Sentinel is not configured';
  $('masterValue').textContent = data.master || (data.master_count>1 ? 'Conflict' : '—');
  $('masterFoot').textContent = master ? endpoint(master) : 'No single master observed';
  $('clusterName').textContent = data.cluster;
  $('pollStatus').textContent = `Every ${data.poll_interval}s · ${data.poll_duration}s collection`;
  $('fleetCount').textContent = `${data.nodes.length} instances`;
  if (!data.nodes.some(n => n.name===selected)) selected = data.master || data.nodes[0]?.name;
  const notice = data.error || (data.mode==='demo' ? 'Demo workspace · These are sample instances. No VMs are contacted.' : data.status==='offline' && data.nodes.length ? 'No Redis instances are reachable. Check that the VMs and containers are running; this view updates automatically.' : data.master_count>1 ? 'More than one Redis instance reports itself as master. Inspect the replication topology.' : '');
  $('notice').textContent = notice;
  $('notice').hidden = !notice;
  renderGraph();
  renderFleet();
  renderInspector();
  renderEvents();
  syncLogControls();
  updateTime();
}

function renderGraph() {
  if (!state) return;
  const nodes = state.nodes, container = $('graphContainer');
  $('graphEmpty').hidden = nodes.length > 0;
  if (!nodes.length) { $('graphNodes').innerHTML=''; $('graphLines').innerHTML=''; return; }
  const w = container.clientWidth;
  const cardWidth = w < 470 ? Math.min(235,w-28) : w < 700 ? 205 : 235;
  const columns = Math.max(1, Math.min(3, Math.floor((w-32)/(cardWidth+28))));
  const masters = nodes.filter(n => n.redis.up && n.redis.role==='master');
  const rest = nodes.filter(n => !masters.includes(n));
  const positions = new Map();
  function row(items, y) {
    items.forEach((node,i) => positions.set(node.name, {x: (w - items.length*cardWidth - (items.length-1)*28)/2+i*(cardWidth+28), y}));
  }
  let nextY=36;
  if (masters.length) {
    for (let i=0;i<masters.length;i+=columns) {row(masters.slice(i,i+columns),nextY);nextY+=202;}
  } else nextY=45;
  for (let i=0;i<rest.length;i+=columns) {row(rest.slice(i,i+columns),nextY);nextY+=196;}
  const height=Math.max(415,nextY+6);
  container.style.height=`${height}px`;
  $('graphLines').setAttribute('viewBox',`0 0 ${w} ${height}`);
  $('graphNodes').innerHTML = nodes.map(node => {
    const p=positions.get(node.name), r=node.redis, active=online(node), isMaster=role(node)==='master';
    return `<button class="node-card ${isMaster?'master':''} ${active?'':'unavailable'} ${node.name===selected?'selected':''}" data-node="${esc(node.name)}" style="left:${p.x}px;top:${p.y}px;width:${cardWidth}px" aria-label="Inspect ${esc(node.name)}, ${role(node)}" aria-pressed="${node.name===selected}">
      <div class="node-top"><span class="node-name">${icon(isMaster?'crown':'server')}${esc(node.name)}</span>${badge(node)}</div>
      <div class="node-address">${esc(endpoint(node))}</div>
      <div class="node-stats"><span>MEMORY<strong>${r.up?bytes(r.memory_used):'—'}</strong></span><span>OPS / SEC<strong>${r.up?fmt(r.ops_per_second):'—'}</strong></span><span>CLIENTS<strong>${r.up?fmt(r.clients):'—'}</strong></span></div>
      <div class="node-footer"><span><i class="dot ${active?'':'red'}"></i>${active ? isMaster?'Accepting writes':r.syncing?'Synchronizing':r.link==='up'?'Replication connected':'Online' : node.reachable?'Redis unavailable':'Server unreachable'}</span><span class="node-sentinel">${icon('shield')}${node.metadata.sentinel_member?(node.sentinel.up?'Sentinel online':'Sentinel unavailable'):'Standalone'}</span></div>
    </button>`;
  }).join('');
  let lines='<defs><marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 6 3 0 6" fill="#a9c7b6" stroke="none"/></marker></defs>';
  nodes.forEach((node,index) => {
    let upstream=nodes.find(other => (other.metadata.replication_address||other.metadata.address)===node.redis.upstream && Number(other.metadata.replication_port||other.metadata.redis_port)===Number(node.redis.upstream_port));
    if (!upstream && !node.redis.up && masters.length===1 && node!==masters[0]) upstream=masters[0];
    if (!upstream || upstream===node) return;
    const from=positions.get(upstream.name),to=positions.get(node.name),connected=node.redis.up&&node.redis.link==='up'&&!node.redis.syncing&&upstream.redis.up;
    const x1=from.x+cardWidth/2,y1=from.y+145,x2=to.x+cardWidth/2,y2=to.y-7;
    const mid=(y1+y2)/2;
    const path=`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`;
    lines+=`<path id="edge-${index}" d="${path}" class="edge ${connected?'':'down'}" marker-end="url(#arrowhead)"/>`;
    if (connected) lines+=`<circle class="flow-particle" r="2.7"><animateMotion dur="3s" begin="-${index}s" repeatCount="indefinite" path="${path}"/></circle>`;
    if (y2>y1) lines+=`<rect x="${(x1+x2)/2-43}" y="${mid-6}" width="86" height="13" rx="3" fill="#fcfdf9" stroke="none"/><text x="${(x1+x2)/2}" y="${mid+3}" text-anchor="middle" class="edge-label ${connected?'':'down'}">${connected?'REPLICATING':'LINK UNAVAILABLE'}</text>`;
  });
  $('graphLines').innerHTML=lines;
}

function sparkline(history) {
  const points=history.filter(p=>p.up).map(p=>p.ops).slice(-20);
  if (points.length<2) return '';
  const min=Math.min(...points),range=Math.max(...points)-min||1;
  const d=points.map((v,i)=>`${i?'L':'M'}${i*52/(points.length-1)},${18-(v-min)/range*13}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 55 22" aria-hidden="true"><path d="${d}"/></svg>`;
}

function renderFleet() {
  $('fleetBody').innerHTML=state.nodes.length?state.nodes.map(node=>`<tr tabindex="0" data-node="${esc(node.name)}" class="${node.name===selected?'selected':''}" aria-label="Inspect ${esc(node.name)}"><td><span class="instance-cell"><i class="dot ${online(node)?'':'red'}"></i><span>${esc(node.name)}<small class="mono">${esc(node.metadata.address)}</small></span></span></td><td>${badge(node)}</td><td><span class="memory-cell mono">${node.redis.up?bytes(node.redis.memory_used):'—'}</span></td><td><span class="memory-cell mono">${node.redis.up?fmt(node.redis.ops_per_second):'—'}${sparkline(node.history)}</span></td><td><span class="sentinel-cell">${icon('shield')}${!node.metadata.sentinel_member?'Not configured':node.sentinel.up ? node.sentinel.quorum_ok?'Quorum ready':'No quorum':'Unavailable'}</span></td></tr>`).join(''):'<tr><td colspan="5" class="table-empty">Waiting for inventory…</td></tr>';
}

function environmentDetails(node) {
  const hw=node.hardware,c=node.container,deployment=node.metadata.deployment || 'nspawn';
  if(deployment==='direct')return `<div class="inspector-section"><div class="detail-label">DIRECT REDIS CONNECTION</div><p class="muted-text">Server hardware, storage, and log files are available with an optional SSH probe.</p></div>`;
  return `<div class="inspector-section"><div class="detail-label">${deployment==='nspawn'?'SERVER & CONTAINER':'SERVER'}${node.stale?' · LAST OBSERVATION':''}</div>${detail('Hostname',hw.hostname)}${detail('Operating system',hw.os)}${detail('Architecture',hw.architecture,true)}${detail('CPU cores / load',hw.cpu_cores?`${hw.cpu_cores} cores · ${Number(hw.load_1m).toFixed(2)} load`:'—')}${detail('CPU utilization',hw.cpu_percent!=null&&!node.stale?`${hw.cpu_percent}%`:'Awaiting samples')}${detail('Service state',node.stale?'Unknown':c.state)}${meter('Server memory',hw.memory_used,hw.memory_total)}${deployment==='nspawn'?meter('Container memory',c.memory_current,c.memory_limit):''}</div>`;
}

function renderInspector() {
  const node=state.nodes.find(n=>n.name===selected);
  if (!node) return;
  const r=node.redis, hw=node.hardware, sentinel=node.sentinel, c=node.container;
  let content='';
  const reason = node.stale ? `Server unreachable · last seen ${age(node.last_seen)}` : !r.up ? r.error==='authentication_failed'?'Redis authentication failed':r.error==='timeout'?'Redis query timed out':'Redis is unavailable' : r.role==='master'?'Current master · accepting writes':r.link==='up'&&!r.syncing?'Replica connected and synchronized':r.syncing?'Replica is synchronizing':'Replication link is down';
  if (selectedTab==='overview') {
    content=`<div class="inspector-section"><div class="inspector-status ${!r.up||node.stale?'error':''}">${icon(r.up?'shield':'info')}${esc(reason)}</div><div class="detail-label">REDIS PROCESS</div>${detail('Version',r.version)}${detail('Uptime',r.up?uptime(r.uptime_seconds):'—')}${detail('Replication offset',r.up?fmt(r.replication_offset):'—',true)}${detail(r.role==='master'?'Connected replicas':'Upstream',r.role==='master'?fmt(r.connected_replicas):r.upstream?`${r.upstream}:${r.upstream_port}`:'—',true)}${detail('Append-only file',r.up?r.aof_enabled?'Enabled':'Disabled':'—')}${detail('RDB / AOF status',r.up?`${r.rdb_status||'unknown'} / ${r.aof_status||'unknown'}`:'—')}${meter('Redis memory',r.up?r.memory_used:null,r.up?r.memory_max:null)}</div>
      ${environmentDetails(node)}
      ${node.metadata.sentinel_member ? `<div class="inspector-section"><div class="detail-label">SENTINEL</div>${detail("Endpoint",`${node.metadata.sentinel_address || node.metadata.address}:${node.metadata.sentinel_port}`,true)}${detail("Quorum",sentinel.up?sentinel.quorum_ok?"Available":"Unavailable":"Unknown")}${detail("Required quorum",sentinel.up?sentinel.required_quorum:"—")}${detail("Known peers",sentinel.up?sentinel.other_sentinels:"—")}${detail("Master view",sentinel.up?`${sentinel.master_ip}:${sentinel.master_port}`:"—",true)}</div>` : `<div class="inspector-section"><div class="detail-label">TOPOLOGY</div><p class="muted-text">Redis monitoring without Sentinel.</p></div>`}`;
  } else {
    content=(node.stale?`<div class="inspector-status error">${icon('info')}Last observation · ${age(node.last_seen)}</div>`:'')+(node.storage.length?node.storage.map(item=>`<div class="storage-item"><div class="storage-name">${esc(item.label)}<span class="mount-state ${item.mounted?'':'bad'}">${item.mounted?'MOUNTED':node.stale?'NOT OBSERVED':'NOT MOUNTED'}</span></div>${meter('Space used',item.used,item.total)}<div class="path-label">SERVER PATH</div><div class="path-value">${esc(item.host_path)}</div>${node.metadata.deployment==='host'?'':`<div class="path-label">INSIDE CONTAINER</div><div class="path-value">${esc(item.container_path)}</div>`}${item.available!=null?`<div class="storage-source">${bytes(item.available)} available · ${esc(item.filesystem||'unknown filesystem')}</div>`:''}${item.source?`<div class="storage-source mono">${esc(item.source)}</div>`:''}</div>`).join(''):'<p class="muted-text">No storage information available yet.</p>')+`<div class="storage-item"><div class="storage-name">Runtime paths</div><div class="path-label">REDIS LOG FILE</div><div class="path-value">${esc(r.logfile||'Not observed')}</div><div class="path-label">REDIS CONFIGURATION</div><div class="path-value">${esc(r.config_file||'Not observed')}</div></div>`;
  }
  $('inspector').innerHTML=`<div class="inspector-head"><div class="section-eyebrow">INSTANCE INSPECTOR</div><div class="inspector-title"><h2>${role(node)==='master'?icon('crown'):''}${esc(node.name)}</h2>${badge(node)}</div><div class="inspector-endpoint"><span>${esc(endpoint(node))}</span><button class="copy-button" data-copy="${esc(endpoint(node))}" title="Copy endpoint" aria-label="Copy endpoint">${icon('copy')}</button></div></div><div class="inspector-tabs"><button data-tab="overview" class="${selectedTab==='overview'?'active':''}" aria-pressed="${selectedTab==='overview'}">Overview</button><button data-tab="storage" class="${selectedTab==='storage'?'active':''}" aria-pressed="${selectedTab==='storage'}">Storage & paths</button></div><div class="inspector-content ${selectedTab==='storage'?'storage-content':''}">${content}</div>`;
}

function renderEvents() {
  $('eventsList').innerHTML=state.events.length?state.events.slice(0,12).map(event=>`<div class="event"><i class="event-dot ${esc(event.kind)}"></i><span class="event-message">${esc(event.message)}</span><time class="event-time" datetime="${new Date(event.time*1000).toISOString()}" title="${new Date(event.time*1000).toLocaleString()}">${age(event.time)}</time></div>`).join(''):'<div class="empty-events">Outages, recoveries, and master promotions will appear here.</div>';
}

function updateTime() {
  if (!state) return;
  const stale=state.updated_at && Date.now()/1000-state.updated_at>Math.max(20,state.poll_interval*3+state.poll_duration);
  $('lastUpdated').textContent=`Last observation ${age(state.updated_at)}`;
  const pill=$('connectionPill'),bad=!serverConnected||stale||!!state.error;
  pill.classList.toggle('disconnected',bad);
  pill.querySelector('span').textContent=bad?stale?'Observation stale':'Collector unavailable':state.mode==='demo'?'Demo workspace':state.status==='loading'?'Connecting':'Live monitoring';
  $('graphContainer').classList.toggle('stale',!!stale||!serverConnected);
}

let fetching=false;
async function fetchSnapshot() {
  if (fetching) return;
  fetching=true;
  const requestedCluster=activeCluster,requestedScenario=scenario;
  try {
    const response=await apiFetch(`/api/cluster?scenario=${encodeURIComponent(scenario)}&cluster=${encodeURIComponent(activeCluster)}`,{cache:'no-store'});
    if (!response.ok) throw Error('request failed');
    const data=await response.json();
    if(requestedCluster!==activeCluster||requestedScenario!==scenario)return;
    serverConnected=true;
    if (data.updated_at!==lastRender||!state) {lastRender=data.updated_at;render(data);} else updateTime();
  } catch {
    serverConnected=false;
    $('notice').hidden=false;
    $('notice').textContent='Dashboard connection lost. Showing the last observation; retrying automatically.';
    updateTime();
  } finally {fetching=false;if(requestedScenario!==scenario||(requestedCluster!==activeCluster&&state?.cluster!==activeCluster))fetchSnapshot();}
}

document.addEventListener('click',async event=>{
  const node=event.target.closest('[data-node]');
  if (node) {selected=node.dataset.node;renderGraph();renderFleet();renderInspector();syncLogControls();}
  const tab=event.target.closest('[data-tab]');
  if (tab) {selectedTab=tab.dataset.tab;renderInspector();}
  const service=event.target.closest('[data-log-service]');
  if (service) {logService=service.dataset.logService;syncLogControls();}
  const copy=event.target.closest('[data-copy]');
  if (copy) {try {await navigator.clipboard.writeText(copy.dataset.copy);copy.title='Copied';copy.setAttribute('aria-label','Endpoint copied');} catch {copy.title='Clipboard unavailable';}}
});
document.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target.matches('tr[data-node]')){event.preventDefault();event.target.click();}});
$('refreshButton').addEventListener('click',async()=>{
  const button=$('refreshButton');button.disabled=true;
  try {const response=await apiFetch('/api/refresh',{method:'POST',headers:{'X-CSRF-Token':document.querySelector('meta[name="csrf-token"]').content}});if(!response.ok)throw Error('Refresh failed');await fetchSnapshot();} catch {serverConnected=false;updateTime();} finally {setTimeout(()=>{button.disabled=false;},800);}
});
$('demoScenario').addEventListener('change',event=>{scenario=event.target.value;lastRender=null;fetchSnapshot();});
$('clusterSelect').addEventListener('change',event=>{activeCluster=event.target.value;selected=null;lastRender=null;fetchSnapshot();});
let resizeTimer;
new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(renderGraph,80);}).observe($('graphContainer'));
setInterval(fetchSnapshot,2000);
setInterval(()=>{updateTime();if(state)renderEvents();},1000);
fetchSnapshot();

let logService='redis', logPaused=false, logFollowing=true, logPayload=null, logContext='', logRequest=0, logRendering='';
function syncLogControls() {
  if (!state) return;
  const dropdown=$('logNode');
  if ([...dropdown.options].map(option=>option.value).join('|')!==state.nodes.map(node=>node.name).join('|')) {
    dropdown.replaceChildren(...state.nodes.map(node=>new Option(node.name,node.name)));
  }
  dropdown.value=selected || '';
  document.querySelectorAll('[data-log-service]').forEach(button=>{
    const active=button.dataset.logService===logService;
    button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
    const node=state.nodes.find(node=>node.name===selected);
    button.querySelector('span').textContent=node?.metadata[button.dataset.logService==='redis'?'redis_port':'sentinel_port'] || '—';
  });
  const context=`${selected}:${logService}:${scenario}`;
  if (context!==logContext) {
    logContext=context;logPayload=null;logRendering='';
    $('logSource').textContent=`${selected || 'No instance'} / ${logService==='redis'?'Redis':'Sentinel'}`;
    $('logOutput').innerHTML='<div class="log-empty">Reading the latest observation…</div>';
    $('logCount').textContent='0 lines';
    fetchLogs(true);
  }
}
async function fetchLogs(force=false) {
  if (!selected || (logPaused&&!force)) return;
  const name=selected, service=logService, request=++logRequest;
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await apiFetch(`/api/logs/${encodeURIComponent(name)}/${service}?scenario=${encodeURIComponent(scenario)}`,{cache:'no-store',signal:controller.signal});
    if (!response.ok) throw Error('Unavailable');
    const data=await response.json();
    if (request!==logRequest||name!==selected||service!==logService||(logPaused&&!force)) return;
    logPayload=data;renderLogs();
  } catch {
    if (request!==logRequest) return;
    $('logStatus').textContent='DISCONNECTED';$('logStatus').className='log-live error';
    $('logUpdated').textContent='Connection lost · retrying automatically';
    if (!logPayload) $('logOutput').innerHTML='<div class="log-empty">Logs are unavailable. Retrying automatically.</div>';
  } finally {clearTimeout(timer);}
}
function renderLogs() {
  if (!logPayload) return;
  const data=logPayload, filter=$('logFilter').value.toLowerCase();
  const visible=data.lines.map((text,index)=>({text,index})).filter(line=>line.text.toLowerCase().includes(filter));
  $('logSource').textContent=data.source || `${data.node} / ${data.service}`;
  $('logSource').title=data.source || '';
  const stale=data.stale||!data.updated_at||Date.now()/1000-data.updated_at>Math.max(20,data.poll_interval*4);
  const status=logPaused?'PAUSED':stale?'STALE':data.status==='ok'?'LIVE':data.status==='pending'?'WAITING':'UNAVAILABLE';
  $('logStatus').textContent=state?.mode==='demo'&&status==='LIVE'?'DEMO':status;
  $('logStatus').className=`log-live ${logPaused?'paused':status==='LIVE'?'':'error'}`;
  $('logCount').textContent=`${visible.length}${filter?` / ${data.lines.length}`:''} lines`;
  $('logUpdated').textContent=`${logPaused?'Paused at':'Observed'} ${age(data.updated_at)} · latest 120 lines`;
  const fingerprint=JSON.stringify([data.node,data.service,visible,filter,status]);
  if (fingerprint===logRendering) return;
  logRendering=fingerprint;
  const output=$('logOutput'), scroll=output.scrollTop;
  const empty=filter?'No lines match your filter.':data.status==='not_configured'?'This service is not configured on the selected instance.':data.status==='unsupported'?'Redis does not expose server logs over its protocol. Use an SSH/server probe to read log files.':stale?'No recent logs. Check that the server or container is reachable.':data.status==='pending'?'Waiting for the first log observation.':data.status!=='ok'?'Unable to read this log. Check its configured path and service state.':'No log entries yet. New entries will appear automatically.';
  const fragment=document.createDocumentFragment();
  if (!visible.length) {
    const message=document.createElement('div');message.className='log-empty';message.textContent=empty;fragment.append(message);
  }
  visible.forEach(({text,index})=>{
    const line=document.createElement('div');
    const severity=/\b(error|fatal|panic|failed|failover-abort)\b/i.test(text)?'error':/\b(warning|warn)\b|\+sdown|\+odown/i.test(text)?'warning':/\+switch-master|\+promoted-slave|Ready to accept|Synchronization.*success/i.test(text)?'event':'';
    line.className=`log-line ${severity}`;
    const number=document.createElement('span');number.className='log-number';number.textContent=String(index+1);number.setAttribute('aria-hidden','true');
    const content=document.createElement('span');content.className='log-text';content.textContent=text;
    line.append(number,content);fragment.append(line);
  });
  output.replaceChildren(fragment);
  output.scrollTop=logFollowing?output.scrollHeight:scroll;
}
$('logNode').addEventListener('change',event=>{
  selected=event.target.value;renderGraph();renderFleet();renderInspector();syncLogControls();
});
$('logFilter').addEventListener('input',renderLogs);
$('logPause').addEventListener('click',()=>{
  logPaused=!logPaused;
  $('logPause').textContent=logPaused?'Resume':'Pause';$('logPause').setAttribute('aria-pressed',String(logPaused));
  renderLogs();if(!logPaused)fetchLogs();
});
$('logFollow').addEventListener('click',()=>{
  logFollowing=!logFollowing;
  $('logFollow').textContent=logFollowing?'Following ↓':'Follow ↓';$('logFollow').setAttribute('aria-pressed',String(logFollowing));
  if(logFollowing)$('logOutput').scrollTop=$('logOutput').scrollHeight;
});
const sections=[...document.querySelectorAll('main section[id]')];
const navigationObserver=new IntersectionObserver(entries=>{
  const visible=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];
  if(!visible)return;
  document.querySelectorAll('.nav-link').forEach(link=>link.classList.toggle('active',link.hash===`#${visible.target.id}`));
},{rootMargin:'-10% 0px -45% 0px',threshold:[0,.2,.5]});
sections.forEach(section=>navigationObserver.observe(section));
// Cached reads do not create additional SSH sessions for browser tabs.
setInterval(fetchLogs,2000);
setInterval(()=>{if(!logPaused&&logPayload)renderLogs();},1000);
