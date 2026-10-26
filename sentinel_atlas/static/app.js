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
const endpoint = n => n.metadata.redis_member ? `${n.metadata.address || n.name}:${n.metadata.redis_port || '—'}` : `${n.metadata.sentinel_address || n.metadata.address || n.name}:${n.metadata.sentinel_port || '—'}`;
const online = n => n.metadata.redis_member ? !!n.redis.up : !!n.sentinel.up;
const role = n => !online(n) ? 'down' : n.metadata.redis_member ? ['master','replica'].includes(n.redis.role) ? n.redis.role : 'unknown' : 'sentinel';
const badge = n => `<span class="role-badge ${role(n)}">${role(n) === 'down' ? 'unavailable' : esc(role(n))}</span>`;
const detail = (label, value, mono=false) => `<div class="detail-row"><span>${esc(label)}</span><strong class="${mono?'mono':''}">${esc(value ?? '—')}</strong></div>`;
function meter(label, value, total) {
  const p = percent(value,total);
  return `<div class="metric-label"><span>${esc(label)}</span><strong>${bytes(value)} / ${bytes(total)}</strong></div><div class="meter"><span class="${p>90?'danger':p>75?'warn':''}" style="width:${p}%"></span></div>`;
}
let state = null, selected = null, selectedTab = 'overview', configFilter = '', scenario = 'healthy', activeCluster='', lastRender = null, serverConnected = false;

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
  $('healthCard').dataset.status = data.status;
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
  renderSentinels();
  renderFleet();
  renderInspector();
  renderEvents();
  syncLogControls();
  updateTime();
}

function syncView(node) {
  const sync=node.replication||{}, r=node.redis;
  const titles={master:'Master',in_sync:'In sync',catching_up:'Catching up',syncing:'Full sync',loading:'Loading dataset',link_down:'Link down',unavailable:'Unavailable',unknown:'Sync unknown',not_applicable:'Sentinel only'};
  const key=sync.state||'unknown';
  const tone=['in_sync','master'].includes(key)?'ready':['link_down','unavailable'].includes(key)?'error':['syncing','loading','catching_up'].includes(key)?'warning':'muted';
  const progress=sync.progress_percent;
  let description=key==='master'?`${fmt(r.connected_replicas)} replicas connected`:key==='not_applicable'?'No Redis replication':key==='unavailable'?'Waiting for Redis':key==='link_down'?'Upstream disconnected':'Offset comparison unavailable';
  if (sync.lag_bytes!=null) description=`${bytes(sync.lag_bytes)} sampled gap`;
  if (key==='syncing') description=progress!=null?`${progress.toFixed(1)}% transferred`:r.sync_read_bytes!=null?`${bytes(r.sync_read_bytes)} received · size unknown`:'Waiting for transfer size';
  if (key==='loading') description=progress!=null?`${progress.toFixed(1)}% loaded`:'Loading the dataset';
  return {key,title:titles[key]||titles.unknown,tone,description,progress};
}

function syncBadge(node) {
  const view=syncView(node);
  return `<span class="sync-badge ${view.tone}"><i></i>${view.title}</span>`;
}

function replicationDetails(node) {
  const view=syncView(node), sync=node.replication||{}, r=node.redis;
  const offset=value=>value!=null?fmt(value):'—';
  return `<div class="inspector-section replication-details"><div class="detail-label">LIVE REPLICATION</div><div class="sync-overview">${syncBadge(node)}<span>${esc(view.description)}</span></div>${view.progress!=null?`<div class="sync-progress" role="progressbar" aria-label="${view.key==='loading'?'Dataset loading':'Full sync transfer'}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${view.progress}"><span style="width:${view.progress}%"></span></div>`:''}${detail('Processed offset',r.up?offset(r.replication_offset):'—',true)}${r.role==='replica'?`${detail('Upstream',sync.upstream_name||r.upstream,true)}${detail('Upstream offset',offset(sync.upstream_offset),true)}${detail('Sampled byte gap',sync.lag_bytes!=null?bytes(sync.lag_bytes):'—',true)}${detail('Master link',r.up?r.link:'—')}${detail('Last upstream I/O',r.up&&r.last_master_io!=null&&r.last_master_io>=0?`${fmt(r.last_master_io)}s ago`:'—')}${view.key==='link_down'?detail('Link down for',r.link_down_seconds!=null&&r.link_down_seconds>=0?`${fmt(r.link_down_seconds)}s`:'—'):''}`:''}<p class="muted-text">Updates every ${state.poll_interval||5}s. Offset gaps compare independent samples of the same replication stream; they are approximate under load.</p></div>`;
}

let graphView = {key:'', zoom:1, width:0, height:0, viewportWidth:0, viewportHeight:0, fit:1};

function layoutGraph(nodes, masterName, cardWidth, cardHeight) {
  const positions=new Map(), master=nodes.find(n=>n.name===masterName&&n.redis.up&&n.redis.role==='master');
  const others=nodes.filter(n=>n!==master).sort((a,b)=>a.name.localeCompare(b.name));
  const stepX=cardWidth+52, stepY=cardHeight+52;
  if(nodes.length===1) return {positions:new Map([[nodes[0].name,{x:40,y:40}]]),width:cardWidth+80,height:cardHeight+80};
  if(master) positions.set(master.name,{x:0,y:0});
  // Each ring has enough space for rectangular cards, including between rings.
  for(let start=0,ring=1;start<others.length;ring++) {
    const count=Math.min(6*ring,others.length-start), radius=ring===1&&count<=4?1.2:1.5*ring;
    for(let i=0;i<count;i++) {
      const angle=2*Math.PI*i/count-(count>2?Math.PI/2:0);
      positions.set(others[start+i].name,{x:Math.cos(angle)*radius*stepX,y:Math.sin(angle)*radius*stepY});
    }
    start+=count;
  }
  let extentX=0,extentY=0;
  positions.forEach(p=>{extentX=Math.max(extentX,Math.abs(p.x));extentY=Math.max(extentY,Math.abs(p.y));});
  const width=2*extentX+cardWidth+80, height=2*extentY+cardHeight+80;
  positions.forEach(p=>{p.x+=width/2-cardWidth/2;p.y+=height/2-cardHeight/2;});
  return {positions,width,height};
}

function updateGraphView(recenter=false) {
  const v=graphView, scale=v.fit*v.zoom;
  const width=Math.max(v.viewportWidth,v.width*scale),height=Math.max(v.viewportHeight,v.height*scale);
  const scene=$('graphScene'), stage=$('graphStage'), viewport=$('graphViewport');
  stage.style.width=`${width}px`;stage.style.height=`${height}px`;
  scene.style.transform=`translate(${(width-v.width*scale)/2}px,${(height-v.height*scale)/2}px) scale(${scale})`;
  $('graphZoom').textContent=`${Math.round(scale*100)}%`;
  $('graphZoomOut').disabled=v.zoom<=1;
  $('graphZoomIn').disabled=scale>=1.5-.000001;
  if(recenter) {viewport.scrollLeft=(width-v.viewportWidth)/2;viewport.scrollTop=(height-v.viewportHeight)/2;}
}

function renderGraph() {
  if (!state) return;
  const nodes = state.nodes.filter(n => n.metadata.redis_member), container = $('graphContainer');
  const focused = $('graphNodes').contains(document.activeElement) ? document.activeElement.dataset.node : null;
  const s = state.summary;
  $('topologyStats').innerHTML = `<span>${icon('server')}<strong>${fmt(s.redis_up)} / ${fmt(s.redis_total)}</strong> Redis online</span><span>${icon('chart')}<strong>${fmt(s.ops)}</strong> ops / sec</span><span>${icon('stack')}<strong>${bytes(s.memory)}</strong> memory</span>`;
  $('graphEmpty').hidden = nodes.length > 0;
  $('graphToolbar').hidden=!nodes.length;
  $('graphViewport').hidden=!nodes.length;
  if (!nodes.length) { $('graphNodes').innerHTML=''; $('graphLines').innerHTML=''; container.style.height='230px'; graphView.key=''; return; }
  const w = Math.max(1,container.clientWidth), cardHeight = 236, cardWidth = 240;
  const masters = nodes.filter(n => n.redis.up && n.redis.role==='master');
  const masterName=masters.length===1?masters[0].name:null;
  const {positions,width,height}=layoutGraph(nodes,masterName,cardWidth,cardHeight);
  const viewportHeight=Math.min(680,Math.max(380,Math.min(w*.78,height)));
  container.style.height=`${viewportHeight+60}px`;
  const key=JSON.stringify([state.cluster,masterName,nodes.map(n=>n.name).sort()]);
  const recenter=key!==graphView.key||w!==graphView.viewportWidth;
  graphView={...graphView,key,width,height,viewportWidth:w,viewportHeight,fit:Math.min(1,w/width,viewportHeight/height),zoom:recenter?1:graphView.zoom};
  $('graphScene').style.width=`${width}px`;$('graphScene').style.height=`${height}px`;
  $('graphLines').setAttribute('viewBox',`0 0 ${width} ${height}`);
  updateGraphView(recenter);
  $('graphNodes').innerHTML = nodes.map(node => {
    const p=positions.get(node.name), r=node.redis, active=online(node), isMaster=role(node)==='master';
    const status=!active?'Unavailable':r.loading?'Loading dataset':isMaster?'Accepting writes':r.syncing?'Synchronizing':r.link==='up'?'Replication connected':'Replication link down';
    const sync=syncView(node);
    const problem=['error','warning'].includes(sync.tone);
    return `<button class="node-card ${role(node)} ${node.name===selected?'selected':''}" data-node="${esc(node.name)}" style="left:${p.x}px;top:${p.y}px;width:${cardWidth}px" aria-label="Inspect ${esc(node.name)}, ${role(node)}" aria-pressed="${node.name===selected}">
      <div class="node-kicker">${icon(isMaster?'crown':'server')} REDIS INSTANCE <span>${node.name===selected?'SELECTED':'INSPECT ↗'}</span></div>
      <div class="node-top"><span class="node-name">${esc(node.name)}</span>${badge(node)}</div>
      <div class="node-address">${esc(endpoint(node))}</div>
      <div class="node-stats"><span>MEMORY<strong>${r.up?bytes(r.memory_used):'—'}</strong></span><span>OPS / SEC<strong>${r.up?fmt(r.ops_per_second):'—'}</strong></span><span>CLIENTS<strong>${r.up?fmt(r.clients):'—'}</strong></span></div>
      <div class="node-sync"><div>${syncBadge(node)}<span class="node-sync-value" title="${esc(sync.description)}">${esc(sync.description)}</span></div>${sync.progress!=null?`<div class="sync-progress" role="progressbar" aria-label="${sync.key==='loading'?'Dataset loading':'Full sync transfer'}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${sync.progress}"><span style="width:${sync.progress}%"></span></div>`:''}</div>
      <div class="node-footer ${problem?'attention':''}"><span><i class="dot ${!active?'red':problem?'amber':''}"></i>${status}</span>${node.metadata.sentinel_member?`<span class="node-sentinel ${node.sentinel.up?'':'attention'}" title="${node.sentinel.up?'Sentinel online':'Sentinel unavailable'}">${icon('shield')}</span>`:''}</div>
    </button>`;
  }).join('');
  if (focused) [...$('graphNodes').children].find(n => n.dataset.node === focused)?.focus({preventScroll:true});
  let lines='<defs><marker id="arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 7 3.5 0 7" class="arrow-fill"/></marker><marker id="arrowhead-down" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 7 3.5 0 7" class="arrow-fill down"/></marker></defs>';
  nodes.forEach((node,index) => {
    const upstream=nodes.find(other => (other.metadata.replication_address||other.metadata.address)===node.redis.upstream && Number(other.metadata.replication_port||other.metadata.redis_port)===Number(node.redis.upstream_port));
    // Only draw observed relationships; an unreachable node's upstream is unknown.
    if (!upstream || upstream===node) return;
    const from=positions.get(upstream.name),to=positions.get(node.name),connected=node.redis.up&&node.redis.link==='up'&&!node.redis.syncing&&!node.redis.loading&&upstream.redis.up;
    const dx=to.x-from.x,dy=to.y-from.y;
    // Attach to the facing borders so links work in every radial direction.
    const ratio=1/Math.max(Math.abs(dx)/(cardWidth/2+8),Math.abs(dy)/(cardHeight/2+8));
    const x1=from.x+cardWidth/2+dx*ratio,y1=from.y+cardHeight/2+dy*ratio;
    const x2=to.x+cardWidth/2-dx*ratio,y2=to.y+cardHeight/2-dy*ratio;
    const path=`M${x1},${y1} L${x2},${y2}`;
    const related=selected===node.name||selected===upstream.name;
    lines+=`<path d="${path}" class="edge ${connected?'':'down'} ${related?'related':''}" marker-end="url(#${connected?'arrowhead':'arrowhead-down'})"/>`;
    if (connected) lines+=`<circle class="flow-particle" r="3"><animateMotion dur="3s" begin="-${index}s" repeatCount="indefinite" path="${path}"/></circle>`;
    if (!connected) lines+=`<rect x="${(x1+x2)/2-55}" y="${(y1+y2)/2-9}" width="110" height="18" rx="9" class="edge-label-bg"/><text x="${(x1+x2)/2}" y="${(y1+y2)/2+3}" text-anchor="middle" class="edge-label down">${node.redis.syncing?'SYNCING':node.redis.loading?'LOADING':'LINK DOWN'}</text>`;
  });
  $('graphLines').innerHTML=lines;
}

function renderSentinels() {
  const watchers=state.nodes.filter(n => n.metadata.sentinel_member);
  const focused=$('sentinelNetwork').contains(document.activeElement) ? document.activeElement.dataset.node : null;
  const master=state.nodes.find(n => n.name===state.master);
  const address=master?.metadata.replication_address||master?.metadata.address;
  const port=Number(master?.metadata.replication_port||master?.metadata.redis_port);
  const status=!watchers.length?'Not configured':state.summary.consensus?'Consensus reached':'Needs attention';
  $('sentinelNetwork').innerHTML=`<div class="sentinel-heading"><div>${icon('shield')}<span>SENTINEL WATCH</span><small>${watchers.length} monitor${watchers.length===1?'':'s'}</small></div><span class="consensus-badge ${state.summary.consensus?'ready':watchers.length?'warning':''}">${state.summary.consensus?icon('shield'):''}${status}</span></div>${watchers.length?`<div class="sentinel-grid">${watchers.map(node=>{
    const s=node.sentinel;
    const agrees=s.up&&s.quorum_ok&&!!master&&s.master_ip===address&&Number(s.master_port)===port&&s.flags==='master';
    const label=!s.up?'Unavailable':!s.quorum_ok?'No quorum':!master?'Master unconfirmed':!agrees?'Master view differs':'Quorum ready';
    return `<button class="sentinel-card ${!s.up?'down':agrees?'ready':'warning'} ${node.name===selected?'selected':''}" data-node="${esc(node.name)}" data-inspect-tab="sentinel" aria-label="Inspect Sentinel on ${esc(node.name)}, ${label}" aria-pressed="${node.name===selected}"><div class="sentinel-card-top">${icon('shield')}<strong>${esc(node.name)}</strong><i class="dot ${!s.up?'red':agrees?'':'amber'}"></i></div><div class="sentinel-address mono">${esc(node.metadata.sentinel_address||node.metadata.address)}:${esc(node.metadata.sentinel_port)}</div><span class="sentinel-state">${label}</span><div class="sentinel-master"><span>MASTER VIEW</span><strong class="mono">${s.up?esc(`${s.master_ip}:${s.master_port}`):'—'}</strong></div><div class="sentinel-facts"><span>Quorum <strong>${s.up?esc(s.required_quorum):'—'}</strong></span><span>Peers <strong>${s.up?esc(s.other_sentinels):'—'}</strong></span></div></button>`;
  }).join('')}</div>`:'<p class="muted-text">This cluster is monitored through Redis. Add Sentinel targets to see quorum and master agreement here.</p>'}`;
  if (focused) [...$('sentinelNetwork').querySelectorAll('[data-node]')].find(n => n.dataset.node===focused)?.focus({preventScroll:true});
}

function sparkline(history) {
  const points=history.filter(p=>p.up).map(p=>p.ops).slice(-20);
  if (points.length<2) return '';
  const min=Math.min(...points),range=Math.max(...points)-min||1;
  const d=points.map((v,i)=>`${i?'L':'M'}${i*52/(points.length-1)},${18-(v-min)/range*13}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 55 22" aria-hidden="true"><path d="${d}"/></svg>`;
}

function renderFleet() {
  $('fleetBody').innerHTML=state.nodes.length?state.nodes.map(node=>`<tr tabindex="0" data-node="${esc(node.name)}" class="${node.name===selected?'selected':''}" aria-label="Inspect ${esc(node.name)}"><td><span class="instance-cell"><i class="dot ${online(node)?'':'red'}"></i><span>${esc(node.name)}<small class="mono">${esc(node.metadata.address)}</small></span></span></td><td>${badge(node)}</td><td class="sync-cell">${syncBadge(node)}<small>${esc(syncView(node).description)}</small></td><td><span class="memory-cell mono">${node.redis.up?bytes(node.redis.memory_used):'—'}</span></td><td><span class="memory-cell mono">${node.redis.up?fmt(node.redis.ops_per_second):'—'}${sparkline(node.history)}</span></td><td><span class="sentinel-cell">${icon('shield')}${!node.metadata.sentinel_member?'Not configured':node.sentinel.up ? node.sentinel.quorum_ok?'Quorum ready':'No quorum':'Unavailable'}</span></td></tr>`).join(''):'<tr><td colspan="6" class="table-empty">Waiting for inventory…</td></tr>';
}

function environmentDetails(node) {
  const hw=node.hardware,c=node.container,deployment=node.metadata.deployment || 'nspawn';
  if(deployment==='direct')return `<div class="inspector-section"><div class="detail-label">DIRECT REDIS CONNECTION</div><p class="muted-text">Server hardware, storage, and log files are available with an optional SSH probe.</p></div>`;
  return `<div class="inspector-section"><div class="detail-label">${deployment==='nspawn'?'SERVER & CONTAINER':'SERVER'}${node.stale?' · LAST OBSERVATION':''}</div>${detail('Hostname',hw.hostname)}${detail('Operating system',hw.os)}${detail('Architecture',hw.architecture,true)}${detail('CPU cores / load',hw.cpu_cores?`${hw.cpu_cores} cores · ${Number(hw.load_1m).toFixed(2)} load`:'—')}${detail('CPU utilization',hw.cpu_percent!=null&&!node.stale?`${hw.cpu_percent}%`:'Awaiting samples')}${detail('Service state',node.stale?'Unknown':c.state)}${meter('Server memory',hw.memory_used,hw.memory_total)}${deployment==='nspawn'?meter('Container memory',c.memory_current,c.memory_limit):''}</div>`;
}

function configurationDetails(node) {
  if (!node.metadata.redis_member) return '<p class="muted-text">This instance only runs Sentinel.</p>';
  if (!node.redis.up || node.stale) return '<p class="muted-text">Configuration is unavailable while Redis is unreachable.</p>';
  if (node.redis.config_status !== 'ok') return '<p class="muted-text">Unable to read configuration. The monitoring account needs permission to run CONFIG GET.</p>';
  return `<div class="configuration-panel"><div class="detail-label">RUNTIME CONFIGURATION</div><p class="muted-text">Settings reported by this Redis node. Credential values are hidden.</p><label class="config-search-label" for="configSearch">Search settings</label><input id="configSearch" class="config-search" type="search" placeholder="Filter by setting or value…" value="${esc(configFilter)}" autocomplete="off"><p id="configCount" class="muted-text" role="status"></p><div id="configRows" class="config-rows"></div></div>`;
}

function renderConfigurationRows() {
  if (!$('configRows')) return;
  const entries = Object.entries(state.nodes.find(n => n.name === selected)?.redis.configuration || {}).sort(([a], [b]) => a.localeCompare(b));
  const query = configFilter.trim().toLowerCase();
  const matches = entries.filter(([key, value]) => `${key} ${value}`.toLowerCase().includes(query));
  $('configCount').textContent = `${matches.length} of ${entries.length} settings`;
  $('configRows').innerHTML = matches.length ? matches.map(([key, value]) => detail(key, value === '' ? '(empty)' : value, true)).join('') : '<p class="muted-text">No settings match your search.</p>';
}

function sentinelDetails(node) {
  const s=node.sentinel;
  const status=node.stale?'Server unreachable':!s.up?'Sentinel unavailable':!s.quorum_ok?'Sentinel online · quorum unavailable':'Sentinel online · quorum available';
  return `<div class="inspector-section"><div class="inspector-status ${!s.up||!s.quorum_ok||node.stale?'error':''}">${icon('shield')}${status}</div><div class="detail-label">SENTINEL MONITOR</div>${detail('Monitored cluster',node.metadata.cluster)}${detail('Required quorum',s.up?s.required_quorum:'—')}${detail('Known Sentinel peers',s.up?s.other_sentinels:'—')}${detail('Known replicas',s.up?s.known_replicas:'—')}<div class="detail-rule"></div><div class="detail-label">REPORTED MASTER</div>${detail('Endpoint',s.up?`${s.master_ip}:${s.master_port}`:'—',true)}${detail('Flags',s.up?s.flags:'—',true)}<p class="muted-text">Each Sentinel reports its own master view. Compare the monitor cards to spot disagreement.</p></div>`;
}

function renderInspector() {
  const focusedTab = document.activeElement?.dataset.tab;
  const searchFocused = document.activeElement?.id === 'configSearch';
  const searchPosition = searchFocused ? document.activeElement.selectionStart : null;
  const searchEnd = searchFocused ? document.activeElement.selectionEnd : null;
  const configScroll = $('inspector').dataset.node === selected ? $('configRows')?.scrollTop || 0 : 0;
  const node=state.nodes.find(n=>n.name===selected);
  if (!node) {
    $('inspector').innerHTML=`<div class="inspector-placeholder">${icon('server')}<h2>Inspect an instance</h2><p>Select a node to explore its configuration and monitoring details.</p></div>`;
    delete $('inspector').dataset.node;
    return;
  }
  const r=node.redis, hw=node.hardware, sentinel=node.sentinel, c=node.container;
  const inspectorEndpoint=selectedTab==='sentinel'?`${node.metadata.sentinel_address||node.metadata.address}:${node.metadata.sentinel_port}`:endpoint(node);
  let content='';
  const reason = !node.metadata.redis_member ? !sentinel.up?'Sentinel is unavailable':sentinel.quorum_ok?'Sentinel online · quorum available':'Sentinel online · no quorum' : node.stale ? `Server unreachable · last seen ${age(node.last_seen)}` : !r.up ? r.error==='authentication_failed'?'Redis authentication failed':r.error==='timeout'?'Redis query timed out':'Redis is unavailable' : r.role==='master'?'Current master · accepting writes':`${syncView(node).title} · ${syncView(node).description}`;
  if (selectedTab==='overview') {
    content=`<div class="inspector-section"><div class="inspector-status ${!online(node)||node.stale?'error':''}">${icon(online(node)?'shield':'info')}${esc(reason)}</div>${node.metadata.redis_member?`<div class="detail-label">REDIS PROCESS</div>${detail('Version',r.version)}${detail('Uptime',r.up?uptime(r.uptime_seconds):'—')}${detail(r.role==='master'?'Connected replicas':'Upstream',r.role==='master'?fmt(r.connected_replicas):r.upstream?`${r.upstream}:${r.upstream_port}`:'—',true)}${detail('Append-only file',r.up?r.aof_enabled?'Enabled':'Disabled':'—')}${detail('RDB / AOF status',r.up?`${r.rdb_status||'unknown'} / ${r.aof_status||'unknown'}`:'—')}${meter('Redis memory',r.up?r.memory_used:null,r.up?r.memory_max:null)}`:''}</div>
      ${node.metadata.redis_member?replicationDetails(node):''}
      ${environmentDetails(node)}
      ${node.metadata.sentinel_member ? `<div class="inspector-section"><div class="detail-label">SENTINEL</div>${detail("Endpoint",`${node.metadata.sentinel_address || node.metadata.address}:${node.metadata.sentinel_port}`,true)}${detail("Quorum",sentinel.up?sentinel.quorum_ok?"Available":"Unavailable":"Unknown")}${detail("Required quorum",sentinel.up?sentinel.required_quorum:"—")}${detail("Known peers",sentinel.up?sentinel.other_sentinels:"—")}${detail("Master view",sentinel.up?`${sentinel.master_ip}:${sentinel.master_port}`:"—",true)}</div>` : `<div class="inspector-section"><div class="detail-label">TOPOLOGY</div><p class="muted-text">Redis monitoring without Sentinel.</p></div>`}`;
  } else if (selectedTab==='sentinel') {
    content=sentinelDetails(node);
  } else if (selectedTab==='configuration') {
    content=configurationDetails(node);
  } else {
    content=(node.stale?`<div class="inspector-status error">${icon('info')}Last observation · ${age(node.last_seen)}</div>`:'')+(node.storage.length?node.storage.map(item=>`<div class="storage-item"><div class="storage-name">${esc(item.label)}<span class="mount-state ${item.mounted?'':'bad'}">${item.mounted?'MOUNTED':node.stale?'NOT OBSERVED':'NOT MOUNTED'}</span></div>${meter('Space used',item.used,item.total)}<div class="path-label">SERVER PATH</div><div class="path-value">${esc(item.host_path)}</div>${node.metadata.deployment==='host'?'':`<div class="path-label">INSIDE CONTAINER</div><div class="path-value">${esc(item.container_path)}</div>`}${item.available!=null?`<div class="storage-source">${bytes(item.available)} available · ${esc(item.filesystem||'unknown filesystem')}</div>`:''}${item.source?`<div class="storage-source mono">${esc(item.source)}</div>`:''}</div>`).join(''):'<p class="muted-text">No storage information available yet.</p>')+`<div class="storage-item"><div class="storage-name">Runtime paths</div><div class="path-label">REDIS LOG FILE</div><div class="path-value">${esc(r.logfile||'Not observed')}</div><div class="path-label">REDIS CONFIGURATION</div><div class="path-value">${esc(r.config_file||'Not observed')}</div></div>`;
  }
  $('inspector').innerHTML=`<div class="inspector-head"><div class="section-eyebrow">INSTANCE INSPECTOR</div><div class="inspector-title"><h2>${selectedTab==='sentinel'?icon('shield'):role(node)==='master'?icon('crown'):''}${esc(node.name)}</h2>${selectedTab==='sentinel'?'<span class="role-badge sentinel">Sentinel</span>':badge(node)}</div><div class="inspector-endpoint"><span>${esc(inspectorEndpoint)}</span><button class="copy-button" data-copy="${esc(inspectorEndpoint)}" title="Copy endpoint" aria-label="Copy endpoint">${icon('copy')}</button></div></div><div class="inspector-tabs"><button data-tab="overview" class="${selectedTab==='overview'?'active':''}" aria-pressed="${selectedTab==='overview'}">Overview</button>${node.metadata.redis_member?`<button data-tab="configuration" class="${selectedTab==='configuration'?'active':''}" aria-pressed="${selectedTab==='configuration'}">Configuration</button>`:''}${node.metadata.sentinel_member?`<button data-tab="sentinel" class="${selectedTab==='sentinel'?'active':''}" aria-pressed="${selectedTab==='sentinel'}">Sentinel</button>`:''}<button data-tab="storage" class="${selectedTab==='storage'?'active':''}" aria-pressed="${selectedTab==='storage'}">Storage & paths</button></div><div class="inspector-content ${selectedTab==='storage'?'storage-content':selectedTab==='configuration'?'configuration-content':''}">${content}</div>`;
  renderConfigurationRows();
  $('inspector').dataset.node = selected;
  if ($('configRows')) $('configRows').scrollTop = configScroll;
  if (focusedTab) [...$('inspector').querySelectorAll('[data-tab]')].find(tab=>tab.dataset.tab===focusedTab)?.focus({preventScroll:true});
  if (searchFocused && $('configSearch')) {
    $('configSearch').focus({preventScroll:true});
    $('configSearch').setSelectionRange(searchPosition, searchEnd);
  }
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
  const graphAction=event.target.closest('[data-graph-action]');
  if(graphAction) {
    const action=graphAction.dataset.graphAction;
    graphView.zoom=action==='fit'?1:Math.max(1,Math.min(1.5/graphView.fit,graphView.zoom*(action==='in'?1.25:.8)));
    updateGraphView(true);
  }
  const node=event.target.closest('[data-node]');
  if (node) {selected=node.dataset.node;configFilter='';selectedTab=node.dataset.inspectTab || (state.nodes.find(n=>n.name===selected)?.metadata.redis_member?'configuration':'overview');renderGraph();renderSentinels();renderFleet();renderInspector();syncLogControls();
    if (window.matchMedia('(max-width: 1000px)').matches) $('inspector').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
  }
  const tab=event.target.closest('[data-tab]');
  if (tab) {selectedTab=tab.dataset.tab;renderInspector();}
  const service=event.target.closest('[data-log-service]');
  if (service) {logService=service.dataset.logService;syncLogControls();}
  const copy=event.target.closest('[data-copy]');
  if (copy) {try {await navigator.clipboard.writeText(copy.dataset.copy);copy.title='Copied';copy.setAttribute('aria-label','Endpoint copied');} catch {copy.title='Clipboard unavailable';}}
});
document.addEventListener('input',event=>{if(event.target.id==='configSearch'){configFilter=event.target.value;renderConfigurationRows();}});
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
  selected=event.target.value;renderGraph();renderSentinels();renderFleet();renderInspector();syncLogControls();
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
