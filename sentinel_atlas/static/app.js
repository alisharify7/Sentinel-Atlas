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
const pageContext=document.body?.dataset||{}, sharedView=pageContext.shared==='true';
const canConfigure=pageContext.config!=='false',canSeeDetails=pageContext.details!=='false';
const canUseTerminal=!sharedView&&pageContext.terminal==='true';
const initialQuery=typeof URLSearchParams!=='undefined'?new URLSearchParams(window.location?.search||''):null;
function meter(label, value, total) {
  const p = percent(value,total);
  return `<div class="metric-label"><span>${esc(label)}</span><strong>${bytes(value)} / ${bytes(total)}</strong></div><div class="meter"><span class="${p>90?'danger':p>75?'warn':''}" style="width:${p}%"></span></div>`;
}
let state = null, selected = initialQuery?.get('node')||null, selectedTab = 'overview', configFilter = '', scenario = 'healthy', activeCluster=initialQuery?.get('cluster')||'', lastRender = null, serverConnected = false, accessLost=false;

function reloadSharedView() {
  accessLost=true;
  $('mainContent')?.replaceChildren();
  location.reload();
}

async function apiFetch(url, options) {
  if(sharedView&&url.startsWith('/api/'))url=(pageContext.apiBase||'/api')+url.slice(4);
  const response=await fetch(url,options);
  if(sharedView&&[403,404].includes(response.status)) {
    reloadSharedView();
    throw Error('Viewing link unavailable');
  }
  if(response.status===401){location.assign('/login?next='+encodeURIComponent(location.pathname));throw Error('Login required');}
  return response;
}

function render(data) {
  state = data;
  activeCluster=data.cluster;
  const clusterSelect=$('clusterSelect'), clusters=data.clusters || [data.cluster];
  if(clusterSelect) {
    if([...clusterSelect.options].map(option=>option.value).join('|')!==clusters.join('|'))clusterSelect.replaceChildren(...clusters.map(name=>new Option(name,name)));
    clusterSelect.value=activeCluster;clusterSelect.hidden=clusters.length<2;
  }
  const s = data.summary;
  const master = data.nodes.find(n => n.name === data.master);
  if($('demoControls')) $('demoControls').hidden = data.mode !== 'demo';
  const health = {healthy:'Healthy', degraded:'Degraded', offline:'Offline', loading:'Discovering'}[data.status] || 'Unknown';
  if($('healthCard')) {
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
  }
  if($('clusterName')) $('clusterName').textContent = data.cluster;
  if($('pollStatus')) $('pollStatus').textContent = `Every ${data.poll_interval}s · ${data.poll_duration}s collection`;
  if (!data.nodes.some(n => n.name===selected)) selected = data.master || data.nodes[0]?.name;
  if(typeof syncWorkspaceLocation==='function'&&!sharedView)syncWorkspaceLocation(activeCluster,selected);
  const notice = data.error || (data.mode==='demo' ? 'Demo workspace · These are sample instances. No VMs are contacted.' : data.status==='offline' && data.nodes.length ? 'No Redis instances are reachable. Check that the VMs and containers are running; this view updates automatically.' : data.master_count>1 ? 'More than one Redis instance reports itself as master. Inspect the replication topology.' : '');
  $('notice').textContent = notice;
  $('notice').hidden = !notice;
  renderGraph();
  renderSentinels();
  renderFleet();
  renderInspector();
  renderEvents();
  renderAttention();
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

let graphView = {key:'', cluster:null, zoom:1, width:0, height:0, viewportWidth:0, viewportHeight:0, fit:1, panX:0, panY:0, minX:0, minY:0, locked:false};
const graphLayouts = new Map();
let graphLayout = null, graphGesture = null, graphSuppressClick = false;

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

function updateGraphView(recenter=false, camera=null) {
  const v=graphView, scale=v.fit*v.zoom;
  const width=Math.max(v.viewportWidth,v.width*scale),height=Math.max(v.viewportHeight,v.height*scale);
  const scene=$('graphScene'), stage=$('graphStage'), viewport=$('graphViewport');
  stage.style.width=`${width}px`;stage.style.height=`${height}px`;
  const baseX=(width-v.width*scale)/2-v.minX*scale, baseY=(height-v.height*scale)/2-v.minY*scale;
  if(camera) {
    v.panX=camera.x+(camera.screen?viewport.scrollLeft:0)-baseX;
    v.panY=camera.y+(camera.screen?viewport.scrollTop:0)-baseY;
  }
  v.x=baseX+v.panX;v.y=baseY+v.panY;v.scale=scale;
  scene.style.transform=`translate(${v.x}px,${v.y}px) scale(${scale})`;
  $('graphZoom').textContent=`${Math.round(scale*100)}%`;
  $('graphZoomOut').disabled=v.locked||v.zoom<=1;
  $('graphZoomIn').disabled=v.locked||scale>=1.5-.000001;
  $('graphFit').disabled=v.locked;
  $('graphReset').disabled=v.locked;
  $('graphLock').setAttribute('aria-pressed',String(v.locked));
  $('graphLock').setAttribute('aria-label',v.locked?'Unlock view':'Lock current view');
  $('graphLock').title=v.locked?'Unlock view':'Lock current view';
  $('graphLock').innerHTML=icon(v.locked?'lock':'unlock');
  $('graphViewport').classList.toggle('view-locked',v.locked);
  $('graphHint').textContent=v.locked?'View locked · Live updates continue':'Scroll to zoom · Drag canvas or nodes to move';
  if(recenter) {viewport.scrollLeft=(width-v.viewportWidth)/2;viewport.scrollTop=(height-v.viewportHeight)/2;}
}

function renderGraph() {
  if (!state||!$('graphContainer')) return;
  const nodes = state.nodes.filter(n => n.metadata.redis_member), container = $('graphContainer');
  const fullscreen=document.fullscreenElement===container||container.classList.contains('graph-expanded');
  const previousCamera={x:graphView.x-$('graphViewport').scrollLeft,y:graphView.y-$('graphViewport').scrollTop,screen:true};
  if(graphView.cluster!==null&&graphView.cluster!==state.cluster) graphView.locked=false;
  if(graphGesture&&(graphView.cluster!==state.cluster||!nodes.length||graphGesture.node&&!nodes.some(n=>n.name===graphGesture.node))) {
    const id=graphGesture.id;
    graphGesture=null;
    $('graphViewport').classList.remove('is-dragging');
    if($('graphViewport').hasPointerCapture(id)) $('graphViewport').releasePointerCapture(id);
  }
  const focused = $('graphNodes').contains(document.activeElement) ? document.activeElement.dataset.node : null;
  const s = state.summary;
  $('topologyStats').innerHTML = `<span>${icon('server')}<strong>${fmt(s.redis_up)} / ${fmt(s.redis_total)}</strong> Redis online</span><span>${icon('chart')}<strong>${fmt(s.ops)}</strong> ops / sec</span><span>${icon('stack')}<strong>${bytes(s.memory)}</strong> memory</span>`;
  $('graphEmpty').hidden = nodes.length > 0;
  $('graphToolbar').hidden=!nodes.length&&!fullscreen;
  $('graphExport').hidden=!nodes.length;
  $('graphHint').hidden=!nodes.length;
  $('graphViewport').hidden=!nodes.length;
  if (!nodes.length) { $('graphNodes').innerHTML=''; $('graphLines').innerHTML=''; container.style.height=fullscreen?'':'230px'; graphView.key='';graphLayout=null;return; }
  const w = Math.max(1,container.clientWidth), cardHeight = 236, cardWidth = 240;
  const masters = nodes.filter(n => n.redis.up && n.redis.role==='master');
  const masterName=masters.length===1?masters[0].name:null;
  const automatic=layoutGraph(nodes,masterName,cardWidth,cardHeight), positions=automatic.positions;
  const sameCluster=graphView.cluster===state.cluster;
  if(!graphLayouts.has(state.cluster)) graphLayouts.set(state.cluster,new Map(typeof loadGraphPositions==='function'?loadGraphPositions(state.cluster):[]));
  const custom=graphLayouts.get(state.cluster);
  for(const name of custom.keys()) if(!positions.has(name)) custom.delete(name);
  positions.forEach((p,name)=>{
    const previous=graphView.locked&&sameCluster?graphLayout?.positions.get(name):null;
    if(previous||custom.has(name)) positions.set(name,{...(previous||custom.get(name))});
  });
  let minX=0,minY=0,maxX=automatic.width,maxY=automatic.height;
  positions.forEach(p=>{minX=Math.min(minX,p.x-40);minY=Math.min(minY,p.y-40);maxX=Math.max(maxX,p.x+cardWidth+40);maxY=Math.max(maxY,p.y+cardHeight+40);});
  const width=maxX-minX,height=maxY-minY;
  const viewportHeight=fullscreen?Math.max(1,container.clientHeight-96):Math.min(644,Math.max(380,Math.min(w*.78,height)));
  container.style.height=fullscreen?'':`${viewportHeight+96}px`;
  const key=JSON.stringify([state.cluster,masterName,nodes.map(n=>n.name).sort()]);
  const preserve=sameCluster&&(graphView.locked||custom.size>0||graphGesture);
  const camera=preserve?(graphView.locked?graphView.lockCamera:previousCamera):null, oldScale=graphView.scale;
  const recenter=!preserve&&(key!==graphView.key||w!==graphView.viewportWidth||viewportHeight!==graphView.viewportHeight);
  const fit=Math.min(1,w/width,viewportHeight/height);
  graphView={...graphView,key,cluster:state.cluster,width,height,minX,minY,viewportWidth:w,viewportHeight,fit,zoom:preserve?oldScale/fit:recenter?1:graphView.zoom,panX:recenter?0:graphView.panX,panY:recenter?0:graphView.panY};
  graphLayout={nodes,positions,cardWidth,cardHeight};
  $('graphScene').style.width=`${width}px`;$('graphScene').style.height=`${height}px`;
  // Keep SVG coordinates in the same world space as the draggable cards.
  $('graphLines').setAttribute('viewBox',`0 0 ${width} ${height}`);
  updateGraphView(recenter,camera);
  $('graphNodes').innerHTML = nodes.map(node => {
    const p=positions.get(node.name), r=node.redis, active=online(node), isMaster=role(node)==='master';
    const status=!active?'Unavailable':r.loading?'Loading dataset':isMaster?'Accepting writes':r.syncing?'Synchronizing':r.link==='up'?'Replication connected':'Replication link down';
    const sync=syncView(node);
    const problem=['error','warning'].includes(sync.tone);
    return `<button class="node-card ${role(node)} ${node.name===selected?'selected':''}" data-node="${esc(node.name)}" style="left:${p.x}px;top:${p.y}px;width:${cardWidth}px" aria-label="Inspect ${esc(node.name)}, ${role(node)}. Drag to move; use Alt and arrow keys to reposition." aria-pressed="${node.name===selected}">
      <div class="node-kicker">${icon(isMaster?'crown':'server')} REDIS INSTANCE <span>${node.name===selected?'SELECTED':'INSPECT ↗'}</span></div>
      <div class="node-top"><span class="node-name">${esc(node.name)}</span>${badge(node)}</div>
      <div class="node-address">${esc(endpoint(node))}</div>
      <div class="node-stats"><span>MEMORY<strong>${r.up?bytes(r.memory_used):'—'}</strong></span><span>OPS / SEC<strong>${r.up?fmt(r.ops_per_second):'—'}</strong></span><span>CLIENTS<strong>${r.up?fmt(r.clients):'—'}</strong></span></div>
      <div class="node-sync"><div>${syncBadge(node)}<span class="node-sync-value" title="${esc(sync.description)}">${esc(sync.description)}</span></div>${sync.progress!=null?`<div class="sync-progress" role="progressbar" aria-label="${sync.key==='loading'?'Dataset loading':'Full sync transfer'}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${sync.progress}"><span style="width:${sync.progress}%"></span></div>`:''}</div>
      <div class="node-footer ${problem?'attention':''}"><span><i class="dot ${!active?'red':problem?'amber':''}"></i>${status}</span>${node.metadata.sentinel_member?`<span class="node-sentinel ${node.sentinel.up?'':'attention'}" title="${node.sentinel.up?'Sentinel online':'Sentinel unavailable'}">${icon('shield')}</span>`:''}</div>
    </button>`;
  }).join('');
  if (focused) [...$('graphNodes').children].find(n => n.dataset.node === focused)?.focus({preventScroll:true});
  renderGraphEdges();
}

function renderGraphEdges() {
  $('graphLines').innerHTML=graphEdgeMarkup(graphLayout);
}

function graphEdgeMarkup(layout,animated=true) {
  const {nodes,positions,cardWidth,cardHeight}=layout;
  let lines='<defs><marker id="arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 7 3.5 0 7" class="arrow-fill"/></marker><marker id="arrowhead-down" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 7 3.5 0 7" class="arrow-fill down"/></marker></defs>';
  nodes.forEach((node,index) => {
    const upstream=nodes.find(other => (other.metadata.replication_address||other.metadata.address)===node.redis.upstream && Number(other.metadata.replication_port||other.metadata.redis_port)===Number(node.redis.upstream_port));
    // Only draw observed relationships; an unreachable node's upstream is unknown.
    if (!upstream || upstream===node) return;
    const from=positions.get(upstream.name),to=positions.get(node.name),connected=node.redis.up&&node.redis.link==='up'&&!node.redis.syncing&&!node.redis.loading&&upstream.redis.up;
    const dx=to.x-from.x,dy=to.y-from.y;
    // Attach to the facing borders so links work in every radial direction.
    const distance=Math.max(Math.abs(dx)/(cardWidth/2+8),Math.abs(dy)/(cardHeight/2+8));
    if(distance<=1) return; // Overlapping cards have no visible link segment.
    const ratio=1/distance;
    const x1=from.x+cardWidth/2+dx*ratio,y1=from.y+cardHeight/2+dy*ratio;
    const x2=to.x+cardWidth/2-dx*ratio,y2=to.y+cardHeight/2-dy*ratio;
    const path=`M${x1},${y1} L${x2},${y2}`;
    const related=selected===node.name||selected===upstream.name;
    lines+=`<path d="${path}" class="edge ${connected?'':'down'} ${related?'related':''}" marker-end="url(#${connected?'arrowhead':'arrowhead-down'})"/>`;
    if (connected&&animated) lines+=`<circle class="flow-particle" r="3"><animateMotion dur="3s" begin="-${index}s" repeatCount="indefinite" path="${path}"/></circle>`;
    if (!connected) lines+=`<rect x="${(x1+x2)/2-55}" y="${(y1+y2)/2-9}" width="110" height="18" rx="9" class="edge-label-bg"/><text x="${(x1+x2)/2}" y="${(y1+y2)/2+3}" text-anchor="middle" class="edge-label down">${node.redis.syncing?'SYNCING':node.redis.loading?'LOADING':'LINK DOWN'}</text>`;
  });
  return lines;
}

function renderSentinels() {
  if(!$('sentinelNetwork')) return;
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
  if(!$('fleetBody')) return;
  const query=($('fleetSearch')?.value||'').trim().toLowerCase(),filter=$('fleetRole')?.value||'';
  const nodes=state.nodes.filter(node=>(!filter||role(node)===filter)&&`${node.name} ${endpoint(node)}`.toLowerCase().includes(query));
  if($('fleetCount')) $('fleetCount').textContent=`${nodes.length} / ${state.nodes.length} instances`;
  $('fleetBody').innerHTML=nodes.length?nodes.map(node=>`<tr tabindex="0" data-node="${esc(node.name)}" class="${node.name===selected?'selected':''}" aria-label="Inspect ${esc(node.name)}"><td><span class="instance-cell"><i class="dot ${online(node)?'':'red'}"></i><span>${esc(node.name)}<small class="mono">${esc(node.metadata.address)}</small></span></span></td><td>${badge(node)}</td><td class="sync-cell">${syncBadge(node)}<small>${esc(syncView(node).description)}</small></td><td><span class="memory-cell mono">${node.redis.up?bytes(node.redis.memory_used):'—'}</span></td><td><span class="memory-cell mono">${node.redis.up?fmt(node.redis.ops_per_second):'—'}${sparkline(node.history)}</span></td><td><span class="sentinel-cell">${icon('shield')}${!node.metadata.sentinel_member?'Not configured':node.sentinel.up ? node.sentinel.quorum_ok?'Quorum ready':'No quorum':'Unavailable'}</span></td></tr>`).join(''):`<tr><td colspan="6" class="table-empty">${state.nodes.length?'No instances match your filters.':'Waiting for inventory…'}</td></tr>`;
}

function environmentDetails(node) {
  if(!canSeeDetails)return '';
  const hw=node.hardware,c=node.container,deployment=node.metadata.deployment || 'nspawn';
  if(deployment==='direct')return `<div class="inspector-section"><div class="detail-label">DIRECT REDIS CONNECTION</div><p class="muted-text">Server hardware, storage, and log files are available with an optional SSH probe.</p></div>`;
  return `<div class="inspector-section"><div class="detail-label">${deployment==='nspawn'?'SERVER & CONTAINER':'SERVER'}${node.stale?' · LAST OBSERVATION':''}</div>${detail('Hostname',hw.hostname)}${detail('Operating system',hw.os)}${detail('Architecture',hw.architecture,true)}${detail('CPU cores / load',hw.cpu_cores?`${hw.cpu_cores} cores · ${Number(hw.load_1m).toFixed(2)} load`:'—')}${detail('CPU utilization',hw.cpu_percent!=null&&!node.stale?`${hw.cpu_percent}%`:'Awaiting samples')}${detail('Service state',node.stale?'Unknown':c.state)}${meter('Server memory',hw.memory_used,hw.memory_total)}${deployment==='nspawn'?meter('Container memory',c.memory_current,c.memory_limit):''}</div>`;
}

function configurationDetails(node) {
  if(!canConfigure)return '<p class="muted-text">Configuration is not included in this viewing link.</p>';
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

const terminalSessions=new Map(), terminalServices=new Map();
const terminalView={expanded:false,fontSize:14,anchor:null,restoreFocus:null,bound:false,inertElements:[]};

function focusTerminalInput() {
  $('terminalInput')?.focus({preventScroll:true});
}
function syncTerminalView() {
  const terminal=$('redisTerminal');
  if(!terminal)return;
  terminal.style.setProperty('--terminal-font-size',`${terminalView.fontSize}px`);
  $('terminalZoomReset').textContent=`${Math.round(terminalView.fontSize/14*100)}%`;
  $('terminalZoomOut').disabled=terminalView.fontSize<=10;
  $('terminalZoomIn').disabled=terminalView.fontSize>=24;
  const button=$('terminalFullscreen');
  button.innerHTML=icon(terminalView.expanded?'collapse':'expand')+`<span>${terminalView.expanded?'Exit fullscreen':'Fullscreen'}</span>`;
  button.title=terminalView.expanded?'Exit fullscreen (Esc)':'Fullscreen (Alt+Enter)';
  button.setAttribute('aria-label',button.title);
  button.setAttribute('aria-pressed',String(terminalView.expanded));
}
function zoomTerminal(delta) {
  const output=$('terminalOutput'),atBottom=output&&output.scrollTop+output.clientHeight>=output.scrollHeight-24;
  terminalView.fontSize=delta===0?14:Math.max(10,Math.min(24,terminalView.fontSize+delta));
  syncTerminalView();
  if(atBottom)output.scrollTop=output.scrollHeight;
}
function setTerminalExpanded(expanded) {
  if(expanded===terminalView.expanded)return;
  const inspector=$('inspector'),dialog=$('terminalDialog');
  if(!inspector||!dialog)return;
  if(expanded) {
    terminalView.restoreFocus=document.activeElement;
    terminalView.anchor=document.createComment('terminal inspector');
    inspector.before(terminalView.anchor);
    dialog.append(inspector);
    terminalView.inertElements=[...document.body.children].filter(element=>element!==dialog).map(element=>[element,element.inert]);
    for(const [element] of terminalView.inertElements)element.inert=true;
    dialog.hidden=false;
  }
  terminalView.expanded=expanded;
  inspector.classList.toggle('terminal-expanded',expanded);
  document.body.classList.toggle('terminal-fullscreen-open',expanded);
  if(!expanded) {
    terminalView.anchor?.replaceWith(inspector);
    terminalView.anchor=null;
    dialog.hidden=true;
    for(const [element,inert] of terminalView.inertElements)element.inert=inert;
    terminalView.inertElements=[];
  }
  syncTerminalView();
  if(expanded)focusTerminalInput();
  else (terminalView.restoreFocus?.isConnected&&terminalView.restoreFocus!==document.body?terminalView.restoreFocus:$('terminalInput')||$('terminalFullscreen'))?.focus({preventScroll:true});
}
function closeTerminalFullscreen() {
  setTerminalExpanded(false);
}
function toggleTerminalFullscreen() {
  setTerminalExpanded(!terminalView.expanded);
}

function terminalContext(node=state?.nodes.find(n=>n.name===selected)) {
  if(!node)return null;
  const nodeKey=JSON.stringify([state.cluster,node.name]);
  const service=terminalServices.get(nodeKey)||(node.metadata.redis_member?'redis':'sentinel');
  const key=JSON.stringify([state.cluster,node.name,service]);
  if(!terminalSessions.has(key))terminalSessions.set(key,{database:0,entries:[],history:[],cursor:0,draft:'',savedDraft:'',busy:false});
  return {node,nodeKey,service,key,session:terminalSessions.get(key)};
}
function terminalPrompt(context) {
  const {node,service,session}=context;
  const address=service==='sentinel'?`${node.metadata.sentinel_address||node.metadata.address}:${node.metadata.sentinel_port}`:endpoint(node);
  return `${address}[${session.database}]>`;
}
function terminalDetails(node) {
  const context=terminalContext(node),{session,service}=context;
  const demo=state.mode==='demo';
  return `<section id="redisTerminal" class="redis-terminal" aria-label="${esc(node.name)} ${service} terminal"><div class="terminal-toolbar"><div class="terminal-heading"><span class="terminal-label">${icon('terminal')} ${demo?'DEMO TERMINAL · SIMULATED':'LIVE TERMINAL'}</span><strong>${esc(node.name)} <span>/ ${service==='redis'?'Redis':'Sentinel'}</span></strong></div><div class="terminal-actions" role="toolbar" aria-label="Terminal view controls"><div class="terminal-zoom"><button type="button" id="terminalZoomOut" title="Zoom out (Ctrl/⌘ −)" aria-label="Zoom terminal out">−</button><button type="button" id="terminalZoomReset" title="Reset zoom (Ctrl/⌘ 0)" aria-label="Reset terminal zoom">100%</button><button type="button" id="terminalZoomIn" title="Zoom in (Ctrl/⌘ +)" aria-label="Zoom terminal in">+</button></div><button type="button" id="terminalFullscreen" aria-pressed="false">${icon('expand')}<span>Fullscreen</span></button></div></div>
    <div class="terminal-controls"><label>Service <select id="terminalService" aria-label="Terminal service">${node.metadata.redis_member?`<option value="redis" ${service==='redis'?'selected':''}>Redis</option>`:''}${node.metadata.sentinel_member?`<option value="sentinel" ${service==='sentinel'?'selected':''}>Sentinel</option>`:''}</select></label><form id="terminalDatabaseForm"><label>DB <input id="terminalDatabase" type="number" min="0" max="2147483647" step="1" value="${session.database}" aria-label="Redis database" ${service==='sentinel'?'disabled':''}></label><button type="submit" ${service==='sentinel'||session.busy?'disabled':''}>Switch</button></form></div>
    <pre id="terminalOutput" class="terminal-output" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Redis command output" tabindex="0"></pre>
    <form id="terminalForm" class="terminal-input-row"><label id="terminalPrompt" for="terminalInput">${esc(terminalPrompt(context))}</label><input id="terminalInput" aria-label="Redis command" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="16384" placeholder="PING" value="${esc(session.draft)}"><button type="submit" aria-label="Run Redis command" ${session.busy?'disabled':''}>Run</button></form>
    <div class="terminal-statusbar"><span id="terminalStatus" role="status">Ready</span><button type="button" class="terminal-clear" data-terminal-clear>Clear output</button><span>↑/↓ history · Ctrl+L clear · Alt+Enter fullscreen</span></div><p class="terminal-help">${demo?'Simulated commands only · no Redis or SSH connections. Try PING, GET demo:message, SELECT 2, or SET on the master. Demo data is temporary and private to your account.':'Enter a Redis command. SELECT 2 switches databases. HELP for examples. Commands run immediately using the configured Redis permissions.'}</p></section>`;
}
function updateTerminal(context=terminalContext(),focus=false) {
  if(!context||selectedTab!=='terminal'||terminalContext()?.key!==context.key||!$('terminalOutput'))return;
  const {session}=context, output=$('terminalOutput');
  const atBottom=output.scrollTop+output.clientHeight>=output.scrollHeight-24;
  output.textContent=session.entries.length?session.entries.join('\n'):`${context.service==='redis'?'Redis':'Sentinel'} terminal ready.\n\nType PING and press Enter to get started.\nUse the database control or SELECT to switch databases.\nOpen Fullscreen for more room, and use + / − to change text size.`;
  if(atBottom||focus)output.scrollTop=output.scrollHeight;
  $('terminalPrompt').textContent=terminalPrompt(context);
  $('terminalInput').value=session.draft;
  $('terminalInput').disabled=false;
  const disabled=session.busy;
  // Allow drafting the next command while the current command is running.
  for(const control of $('terminalForm').querySelectorAll('button'))control.disabled=disabled;
  for(const control of $('terminalDatabaseForm').querySelectorAll('input,button'))control.disabled=disabled||context.service==='sentinel';
  $('terminalDatabase').value=session.database;
  $('terminalStatus').textContent=session.busy?'Executing… You can type your next command.':'Ready · Enter to run';
  if(focus)focusTerminalInput();
}
function appendTerminal(session,text) {
  session.entries.push(text.slice(0,65536));
  while(session.entries.length>100||session.entries.join('\n').length>131072)session.entries.shift();
}
async function executeTerminal(command,context=terminalContext()) {
  if(!context||!canUseTerminal||context.session.busy||!command.trim())return;
  const {session,node,service}=context;
  session.draft='';session.savedDraft='';
  if(session.history.at(-1)!==command)session.history.push(command);
  session.history=session.history.slice(-100);session.cursor=session.history.length;
  appendTerminal(session,`${terminalPrompt(context)} ${command}`);
  const local=command.trim().toLowerCase();
  if(local==='clear'){session.entries=[];updateTerminal(context,true);return;}
  if(local==='help') {
    appendTerminal(session,`PING · INFO · GET "my key" · SET "my key" "hello world" · ${state.mode==='demo'?'SCAN 0':'SCAN 0 COUNT 100'} · SELECT 2\nUse quotes for spaces and empty values. Each command uses an isolated connection.\n↑/↓ history · Ctrl+L clear · Ctrl/⌘ +/− zoom · Ctrl/⌘ 0 reset zoom · Alt+Enter fullscreen\nTransactions, subscriptions, and MONITOR need a persistent client and are unavailable here.`);
    updateTerminal(context,true);return;
  }
  session.busy=true;updateTerminal(context,true);
  try {
    const response=await apiFetch(`/api/terminal/${encodeURIComponent(node.name)}/${service}`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':document.querySelector('meta[name="csrf-token"]').content},body:JSON.stringify({command,database:session.database})});
    const result=await response.json();
    if(!response.ok)throw Error(result.error||'Command failed.');
    if(result.ok)session.database=result.database;
    appendTerminal(session,result.output||'(empty response)');
  } catch(error) {
    appendTerminal(session,`(error) ${error instanceof TypeError?'Connection lost; the command may have executed. Check Redis before retrying.':error.message}`);
  } finally {session.busy=false;updateTerminal(context,true);}
}
function bindTerminal() {
  if(!$('redisTerminal'))return;
  updateTerminal();
  syncTerminalView();
  $('terminalZoomOut').addEventListener('click',()=>zoomTerminal(-1));
  $('terminalZoomIn').addEventListener('click',()=>zoomTerminal(1));
  $('terminalZoomReset').addEventListener('click',()=>zoomTerminal(0));
  $('terminalFullscreen').addEventListener('click',toggleTerminalFullscreen);
  $('redisTerminal').addEventListener('keydown',event=>{
    if(event.altKey&&event.key==='Enter'){event.preventDefault();toggleTerminalFullscreen();}
    if((event.ctrlKey||event.metaKey)&&['+','=','-','0'].includes(event.key)) {
      event.preventDefault();zoomTerminal(event.key==='0'?0:event.key==='-'?-1:1);
    }
  });
  $('terminalOutput').addEventListener('click',()=>{if(!window.getSelection()?.toString())focusTerminalInput();});
  if(!terminalView.bound&&$('terminalDialog')) {
    terminalView.bound=true;
    $('terminalDialog').addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();closeTerminalFullscreen();}
      if(event.key==='Tab') {
        const controls=[...$('terminalDialog').querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')].filter(element=>element.getClientRects().length);
        const first=controls[0],last=controls.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    });
  }
  $('terminalForm').addEventListener('submit',event=>{event.preventDefault();executeTerminal($('terminalInput').value);});
  $('terminalDatabaseForm').addEventListener('submit',event=>{event.preventDefault();if($('terminalDatabase').value!==''&&$('terminalDatabase').checkValidity())executeTerminal(`SELECT ${Number($('terminalDatabase').value)}`);});
  $('terminalService').addEventListener('change',event=>{terminalServices.set(terminalContext().nodeKey,event.target.value);renderInspector(true);});
  $('terminalInput').addEventListener('input',event=>{terminalContext().session.draft=event.target.value;});
  $('terminalInput').addEventListener('keydown',event=>{
    const {session}=terminalContext();
    if(event.ctrlKey&&event.key.toLowerCase()==='l'){event.preventDefault();session.entries=[];updateTerminal();}
    if(event.ctrlKey&&event.key.toLowerCase()==='c'&&event.target.selectionStart===event.target.selectionEnd){event.preventDefault();session.draft='';updateTerminal();}
    if(event.key==='ArrowUp'||event.key==='ArrowDown') {
      event.preventDefault();
      if(session.cursor===session.history.length)session.savedDraft=$('terminalInput').value;
      session.cursor=Math.max(0,Math.min(session.history.length,session.cursor+(event.key==='ArrowUp'?-1:1)));
      session.draft=session.history[session.cursor]??session.savedDraft;
      $('terminalInput').value=session.draft;
    }
  });
}

function renderInspector(force=false) {
  if(!$('inspector'))return;
  if(selectedTab==='configuration'&&!canConfigure||selectedTab==='storage'&&!canSeeDetails||selectedTab==='terminal'&&!canUseTerminal)selectedTab='overview';
  const focusedTab = document.activeElement?.dataset.tab;
  const searchFocused = document.activeElement?.id === 'configSearch';
  const searchPosition = searchFocused ? document.activeElement.selectionStart : null;
  const searchEnd = searchFocused ? document.activeElement.selectionEnd : null;
  const configScroll = $('inspector').dataset.node === selected ? $('configRows')?.scrollTop || 0 : 0;
  const node=state.nodes.find(n=>n.name===selected);
  if(terminalView.expanded&&(!node||selectedTab!=='terminal'))closeTerminalFullscreen();
  if (!node) {
    $('inspector').innerHTML=`<div class="inspector-placeholder">${icon('server')}<h2>Inspect an instance</h2><p>Select a node to explore its configuration and monitoring details.</p></div>`;
    delete $('inspector').dataset.node;
    return;
  }
  const r=node.redis, hw=node.hardware, sentinel=node.sentinel, c=node.container;
  // Polling must preserve the live input, caret, output scroll, and pending command.
  if(!force&&selectedTab==='terminal'&&$('redisTerminal')&&$('inspector').dataset.node===selected&&$('inspector').dataset.cluster===state.cluster)return;
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
  } else if (selectedTab==='terminal') {
    content=terminalDetails(node);
  } else {
    content=(node.stale?`<div class="inspector-status error">${icon('info')}Last observation · ${age(node.last_seen)}</div>`:'')+(node.storage.length?node.storage.map(item=>`<div class="storage-item"><div class="storage-name">${esc(item.label)}<span class="mount-state ${item.mounted?'':'bad'}">${item.mounted?'MOUNTED':node.stale?'NOT OBSERVED':'NOT MOUNTED'}</span></div>${meter('Space used',item.used,item.total)}<div class="path-label">SERVER PATH</div><div class="path-value">${esc(item.host_path)}</div>${node.metadata.deployment==='host'?'':`<div class="path-label">INSIDE CONTAINER</div><div class="path-value">${esc(item.container_path)}</div>`}${item.available!=null?`<div class="storage-source">${bytes(item.available)} available · ${esc(item.filesystem||'unknown filesystem')}</div>`:''}${item.source?`<div class="storage-source mono">${esc(item.source)}</div>`:''}</div>`).join(''):'<p class="muted-text">No storage information available yet.</p>')+`<div class="storage-item"><div class="storage-name">Runtime paths</div><div class="path-label">REDIS LOG FILE</div><div class="path-value">${esc(r.logfile||'Not observed')}</div><div class="path-label">REDIS CONFIGURATION</div><div class="path-value">${esc(r.config_file||'Not observed')}</div></div>`;
  }
  $('inspector').innerHTML=`<div class="inspector-head"><div class="section-eyebrow">INSTANCE INSPECTOR</div><div class="inspector-title"><h2>${selectedTab==='sentinel'?icon('shield'):role(node)==='master'?icon('crown'):''}${esc(node.name)}</h2>${selectedTab==='sentinel'?'<span class="role-badge sentinel">Sentinel</span>':badge(node)}</div><div class="inspector-endpoint"><span>${esc(inspectorEndpoint)}</span><button class="copy-button" data-copy="${esc(inspectorEndpoint)}" title="Copy endpoint" aria-label="Copy endpoint">${icon('copy')}</button></div></div><div class="inspector-tabs"><button data-tab="overview" class="${selectedTab==='overview'?'active':''}" aria-pressed="${selectedTab==='overview'}">Overview</button>${node.metadata.redis_member&&canConfigure?`<button data-tab="configuration" class="${selectedTab==='configuration'?'active':''}" aria-pressed="${selectedTab==='configuration'}">Configuration</button>`:''}${node.metadata.sentinel_member?`<button data-tab="sentinel" class="${selectedTab==='sentinel'?'active':''}" aria-pressed="${selectedTab==='sentinel'}">Sentinel</button>`:''}${canUseTerminal?`<button data-tab="terminal" class="${selectedTab==='terminal'?'active':''}" aria-pressed="${selectedTab==='terminal'}">Terminal</button>`:''}${canSeeDetails?`<button data-tab="storage" class="${selectedTab==='storage'?'active':''}" aria-pressed="${selectedTab==='storage'}">Storage & paths</button>`:''}</div><div class="inspector-content ${selectedTab==='terminal'?'terminal-content':selectedTab==='storage'?'storage-content':selectedTab==='configuration'?'configuration-content':''}">${content}</div>`;
  renderConfigurationRows();
  $('inspector').dataset.node = selected;
  $('inspector').dataset.cluster = state.cluster;
  bindTerminal();
  if ($('configRows')) $('configRows').scrollTop = configScroll;
  if (focusedTab) [...$('inspector').querySelectorAll('[data-tab]')].find(tab=>tab.dataset.tab===focusedTab)?.focus({preventScroll:true});
  if(selectedTab==='terminal')focusTerminalInput();
  if (searchFocused && $('configSearch')) {
    $('configSearch').focus({preventScroll:true});
    $('configSearch').setSelectionRange(searchPosition, searchEnd);
  }
}

function renderEvents() {
  if(!$('eventsList'))return;
  const filter=$('eventFilter')?.value||'',events=state.events.filter(event=>!filter||event.kind===filter);
  $('eventsList').innerHTML=events.length?events.slice(0,pageContext.page==='activity'?60:12).map(event=>`<div class="event"><i class="event-dot ${esc(event.kind)}"></i><span class="event-message">${esc(event.message)}</span><time class="event-time" datetime="${new Date(event.time*1000).toISOString()}" title="${typeof formatWorkspaceDate==='function'?esc(formatWorkspaceDate(event.time)):new Date(event.time*1000).toLocaleString()}">${age(event.time)}</time></div>`).join(''):`<div class="empty-events">${filter?'No events of this type yet.':'Outages, recoveries, and master promotions will appear here.'}</div>`;
}

function renderAttention() {
  if(!$('attentionList'))return;
  const issues=[];
  if(!state.updated_at)issues.push('Waiting for the first cluster observation.');
  if(state.master_count>1)issues.push('Multiple Redis nodes report themselves as master. Check replication before writing.');
  if(!state.master&&state.nodes.length)issues.push('No single master is confirmed for this cluster.');
  state.nodes.forEach(node=>{
    if(!online(node))issues.push(`${node.name} is unavailable.`);
    else if(['error','warning'].includes(syncView(node).tone))issues.push(`${node.name}: ${syncView(node).title} · ${syncView(node).description}.`);
    if(node.metadata.sentinel_member&&(!node.sentinel.up||!node.sentinel.quorum_ok))issues.push(`${node.name}: Sentinel ${node.sentinel.up?'cannot reach quorum':'is unavailable'}.`);
  });
  if(state.summary.sentinel_total&&!state.summary.consensus)issues.push('Sentinels do not all agree on the current master.');
  $('attentionList').innerHTML=issues.length?issues.map(issue=>`<div class="attention-item">${icon('info')}<span>${esc(issue)}</span></div>`).join(''):`<div class="attention-good">${icon('shield')}<div><strong>All clear</strong><span>Every observed Redis instance is reporting normally.</span></div></div>`;
}

function updateTime() {
  if (!state||accessLost) return;
  const stale=state.updated_at && Date.now()/1000-state.updated_at>Math.max(20,state.poll_interval*3+state.poll_duration);
  $('lastUpdated').textContent=`Last observation ${age(state.updated_at)}`;
  const pill=$('connectionPill'),bad=!serverConnected||stale||!!state.error;
  pill.classList.toggle('disconnected',bad);
  pill.querySelector('span').textContent=bad?stale?'Observation stale':'Collector unavailable':state.mode==='demo'?'Demo workspace':state.status==='loading'?'Connecting':'Live monitoring';
  $('graphContainer')?.classList.toggle('stale',!!stale||!serverConnected);
}

let fetching=false;
async function fetchSnapshot() {
  if (fetching||accessLost) return;
  fetching=true;
  const requestedCluster=activeCluster,requestedScenario=scenario;
  try {
    const response=await apiFetch(`/api/cluster?scenario=${encodeURIComponent(scenario)}&cluster=${encodeURIComponent(activeCluster)}`,{cache:'no-store'});
    if (!response.ok) throw Error('request failed');
    const data=await response.json();
    if(sharedView&&data.share_revision!==pageContext.shareRevision) {reloadSharedView();return;}
    if(requestedCluster!==activeCluster||requestedScenario!==scenario)return;
    serverConnected=true;
    if (data.updated_at!==lastRender||!state) {lastRender=data.updated_at;render(data);} else updateTime();
  } catch {
    if(accessLost)return;
    serverConnected=false;
    $('notice').hidden=false;
    $('notice').textContent='Dashboard connection lost. Showing the last observation; retrying automatically.';
    updateTime();
  } finally {fetching=false;if(requestedScenario!==scenario||(requestedCluster!==activeCluster&&state?.cluster!==activeCluster))fetchSnapshot();}
}

function moveGraphNode(name,x,y) {
  const p={x,y};
  graphLayout.positions.set(name,p);
  graphLayouts.get(state.cluster).set(name,p);
  if(typeof persistGraphPositions==='function')persistGraphPositions(state.cluster,graphLayouts.get(state.cluster));
  const card=[...$('graphNodes').children].find(n=>n.dataset.node===name);
  if(card) {card.style.left=`${x}px`;card.style.top=`${y}px`;}
  renderGraphEdges();
}

function finishGraphGesture(event) {
  if(!graphGesture||event.pointerId!==graphGesture.id) return;
  const gesture=graphGesture;
  graphGesture=null;
  $('graphViewport').classList.remove('is-dragging');
  if($('graphViewport').hasPointerCapture(gesture.id)) $('graphViewport').releasePointerCapture(gesture.id);
  if(gesture.moved) {
    // Pointer capture retargets the following click to the viewport.
    graphSuppressClick=true;
    setTimeout(()=>{graphSuppressClick=false;},0);
    renderGraph();
  }
}

function zoomGraph(factor,screenX=graphView.viewportWidth/2,screenY=graphView.viewportHeight/2) {
  if(graphView.locked||!graphLayout)return;
  const viewport=$('graphViewport'),oldScale=graphView.scale;
  const x=(screenX+viewport.scrollLeft-graphView.x)/oldScale,y=(screenY+viewport.scrollTop-graphView.y)/oldScale;
  const scale=Math.max(Math.min(graphView.fit,oldScale),Math.min(1.5,oldScale*factor));
  graphView.zoom=scale/graphView.fit;
  updateGraphView(false,{x:screenX-x*scale,y:screenY-y*scale,screen:true});
}

function bindGraphInteractions() {
  const viewport=$('graphViewport');
  if(!viewport)return;
  viewport.addEventListener('pointerdown',event=>{
    if(graphView.locked||!graphLayout||event.button!==0||event.isPrimary===false||graphGesture) return;
    const card=event.target.closest('.node-card'), p=card?graphLayout.positions.get(card.dataset.node):null;
    graphGesture={id:event.pointerId,node:card?.dataset.node,startX:event.clientX,startY:event.clientY,x:p?.x,y:p?.y,panX:graphView.panX,panY:graphView.panY,scale:graphView.scale,moved:false};
  });
  viewport.addEventListener('pointermove',event=>{
    const g=graphGesture;
    if(!g||event.pointerId!==g.id) return;
    const dx=event.clientX-g.startX,dy=event.clientY-g.startY;
    if(!g.moved&&Math.hypot(dx,dy)<4) return;
    event.preventDefault();
    if(!g.moved) {g.moved=true;viewport.setPointerCapture(g.id);viewport.classList.add('is-dragging');}
    if(g.node) moveGraphNode(g.node,g.x+dx/g.scale,g.y+dy/g.scale);
    else {graphView.panX=g.panX+dx;graphView.panY=g.panY+dy;updateGraphView();}
  });
  for(const type of ['pointerup','pointercancel','lostpointercapture']) viewport.addEventListener(type,finishGraphGesture);
  // Also finish taps that leave the canvas before reaching the drag threshold.
  document.addEventListener('pointerup',finishGraphGesture);
  document.addEventListener('pointercancel',finishGraphGesture);
  viewport.addEventListener('click',event=>{if(graphSuppressClick){event.preventDefault();event.stopPropagation();}},true);
  viewport.addEventListener('wheel',event=>{
    event.preventDefault();
    if(graphView.locked||graphGesture||!graphLayout||!event.deltaY)return;
    const units=event.deltaMode===1?16:event.deltaMode===2?graphView.viewportHeight:1;
    const delta=Math.max(-100,Math.min(100,event.deltaY*units)),bounds=viewport.getBoundingClientRect();
    zoomGraph(Math.exp(-delta*.0025),event.clientX-bounds.left,event.clientY-bounds.top);
  },{passive:false});
  viewport.addEventListener('keydown',event=>{
    const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if(!delta) return;
    const card=event.target.closest('.node-card');
    if(event.target!==viewport&&!(card&&event.altKey)) return;
    event.preventDefault();
    if(graphView.locked||!graphLayout) return;
    const step=event.shiftKey?50:20;
    if(card) {const p=graphLayout.positions.get(card.dataset.node);moveGraphNode(card.dataset.node,p.x+delta[0]*step,p.y+delta[1]*step);renderGraph();}
    else {graphView.panX-=delta[0]*step;graphView.panY-=delta[1]*step;updateGraphView();}
  });
  document.addEventListener('fullscreenchange',()=>{syncGraphFullscreen();renderGraph();});
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&$('graphContainer').classList.contains('graph-expanded')) {setGraphExpanded(false);renderGraph();}
    if(event.key==='Escape') $('graphExport').removeAttribute('open');
  });
}

function syncGraphFullscreen() {
  const expanded=document.fullscreenElement===$('graphContainer')||$('graphContainer').classList.contains('graph-expanded');
  $('graphFullscreen').innerHTML=icon(expanded?'collapse':'expand');
  $('graphFullscreen').setAttribute('aria-pressed',String(expanded));
  $('graphFullscreen').setAttribute('aria-label',expanded?'Exit fullscreen':'Enter fullscreen');
  $('graphFullscreen').title=expanded?'Exit fullscreen':'Enter fullscreen';
}

function setGraphExpanded(expanded) {
  $('graphContainer').classList.toggle('graph-expanded',expanded);
  document.body.classList.toggle('graph-fullscreen-open',expanded);
  syncGraphFullscreen();
  if(!expanded) $('graphFullscreen').focus({preventScroll:true});
}

async function toggleGraphFullscreen() {
  const container=$('graphContainer');
  if(document.fullscreenElement===container) {await document.exitFullscreen();return;}
  if(container.classList.contains('graph-expanded')) {setGraphExpanded(false);renderGraph();return;}
  if(container.requestFullscreen) {
    try {await container.requestFullscreen();return;} catch { /* Embedded browsers may only support an expanded view. */ }
  }
  setGraphExpanded(true);
  renderGraph();
}

document.addEventListener('click',async event=>{
  if(!event.target.closest('#graphExport')) $('graphExport')?.removeAttribute('open');
  const graphAction=event.target.closest('[data-graph-action]');
  if(graphAction) {
    const action=graphAction.dataset.graphAction;
    if(action==='download') {await downloadGraph(graphAction.dataset.format);return;}
    if(action==='fullscreen') {await toggleGraphFullscreen();return;}
    if(!graphLayout) return;
    if(action==='lock') {
      graphView.locked=!graphView.locked;
      graphView.lockCamera={x:graphView.x-$('graphViewport').scrollLeft,y:graphView.y-$('graphViewport').scrollTop,screen:true};
      updateGraphView();return;
    }
    if(graphView.locked) return;
    if(action==='reset') {graphLayouts.get(state.cluster)?.clear();if(typeof persistGraphPositions==='function')persistGraphPositions(state.cluster,new Map());graphView.key='';renderGraph();return;}
    if(action==='fit') {graphView.zoom=1;graphView.panX=0;graphView.panY=0;updateGraphView(true);return;}
    zoomGraph(action==='in'?1.25:.8);
    return;
  }
  const node=event.target.closest('[data-node]');
  if (node&&node!==$('inspector')) {selected=node.dataset.node;configFilter='';selectedTab=node.dataset.inspectTab || (canConfigure&&state.nodes.find(n=>n.name===selected)?.metadata.redis_member?'configuration':'overview');renderGraph();renderSentinels();renderFleet();renderInspector();syncLogControls();
    if(typeof syncWorkspaceLocation==='function'&&!sharedView)syncWorkspaceLocation(activeCluster,selected);
    if (window.matchMedia('(max-width: 1000px)').matches) $('inspector')?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
  }
  const tab=event.target.closest('[data-tab]');
  if (tab) {selectedTab=tab.dataset.tab;renderInspector();}
  if(event.target.closest('[data-terminal-clear]')){terminalContext().session.entries=[];updateTerminal();}
  const service=event.target.closest('[data-log-service]');
  if (service) {logService=service.dataset.logService;syncLogControls();}
  const copy=event.target.closest('[data-copy]');
  if (copy) {try {await navigator.clipboard.writeText(copy.dataset.copy);copy.title='Copied';copy.setAttribute('aria-label','Endpoint copied');} catch {copy.title='Clipboard unavailable';}}
});
document.addEventListener('input',event=>{if(event.target.id==='configSearch'){configFilter=event.target.value;renderConfigurationRows();}});
document.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target.matches('tr[data-node]')){event.preventDefault();event.target.click();}});
bindGraphInteractions();
$('refreshButton').addEventListener('click',async()=>{
  const button=$('refreshButton');button.disabled=true;
  try {if(!sharedView){const response=await apiFetch('/api/refresh',{method:'POST',headers:{'X-CSRF-Token':document.querySelector('meta[name="csrf-token"]').content}});if(!response.ok)throw Error('Refresh failed');}await fetchSnapshot();} catch {if(!accessLost){serverConnected=false;updateTime();}} finally {setTimeout(()=>{button.disabled=false;},800);}
});
$('demoScenario')?.addEventListener('change',event=>{scenario=event.target.value;lastRender=null;fetchSnapshot();});
$('clusterSelect')?.addEventListener('change',event=>{activeCluster=event.target.value;selected=null;lastRender=null;fetchSnapshot();});
$('fleetSearch')?.addEventListener('input',()=>{if(state)renderFleet();});
$('fleetRole')?.addEventListener('change',()=>{if(state)renderFleet();});
$('eventFilter')?.addEventListener('change',()=>{if(state)renderEvents();});
let resizeTimer;
if($('graphContainer'))new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(renderGraph,80);}).observe($('graphContainer'));
setInterval(fetchSnapshot,2000);
setInterval(()=>{updateTime();if(state)renderEvents();},1000);
fetchSnapshot();

let logService='redis', logPaused=false, logFollowing=true, logPayload=null, logContext='', logRequest=0, logRendering='';
function syncLogControls() {
  if (!state||!$('logNode')) return;
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
  const context=`${activeCluster}:${selected}:${logService}:${scenario}`;
  if (context!==logContext) {
    logContext=context;logPayload=null;logRendering='';
    $('logSource').textContent=`${selected || 'No instance'} / ${logService==='redis'?'Redis':'Sentinel'}`;
    $('logOutput').innerHTML='<div class="log-empty">Reading the latest observation…</div>';
    $('logCount').textContent='0 lines';
    if($('logDownloadStatus'))$('logDownloadStatus').textContent='';
    fetchLogs(true);
  }
  updateLogDownload();
}
function updateLogDownload() {
  const button=$('logDownload');
  if(!button)return;
  const current=logPayload&&logPayload.node===selected&&logPayload.service===logService;
  const filter=($('logFilter')?.value||'').toLowerCase();
  const count=current?logPayload.lines.filter(line=>line.toLowerCase().includes(filter)).length:0;
  button.disabled=!count||accessLost;
  button.title=count?`Download ${count} ${logService==='redis'?'Redis':'Sentinel'} log line${count===1?'':'s'} as a .log file`:current&&logPayload.lines.length?'No lines match the current filter.':'Waiting for collected log lines. Server probes are required for live logs.';
}
function downloadLogs() {
  const status=$('logDownloadStatus');
  if(!status||accessLost)return;
  status.classList.remove('error');
  try {
    if(!logPayload||logPayload.node!==selected||logPayload.service!==logService)throw Error('Wait for logs from the selected instance and service.');
    // Capture synchronously, including the paused observation and current filter.
    const snapshot=logExportSnapshot(logPayload,{filter:$('logFilter').value,mode:state?.mode});
    downloadLogSnapshot(snapshot);
    status.textContent=`${logService==='redis'?'Redis':'Sentinel'} download ready · ${snapshot.lineCount} line${snapshot.lineCount===1?'':'s'}.`;
  } catch(error) {
    status.classList.add('error');status.textContent=error.message||'Download failed. Please try again.';
  }
}
async function fetchLogs(force=false) {
  if (!selected || !$('logNode') || accessLost || (logPaused&&!force)) return;
  const name=selected, service=logService, cluster=activeCluster, request=++logRequest;
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await apiFetch(`/api/logs/${encodeURIComponent(name)}/${service}?scenario=${encodeURIComponent(scenario)}`,{cache:'no-store',signal:controller.signal});
    if (!response.ok) throw Error('Unavailable');
    const data=await response.json();
    if (request!==logRequest||name!==selected||cluster!==activeCluster||service!==logService||(logPaused&&!force)) return;
    logPayload=data;renderLogs();
  } catch {
    if(accessLost)return;
    if (request!==logRequest) return;
    $('logStatus').textContent='DISCONNECTED';$('logStatus').className='log-live error';
    $('logUpdated').textContent='Connection lost · retrying automatically';
    if (!logPayload) $('logOutput').innerHTML='<div class="log-empty">Logs are unavailable. Retrying automatically.</div>';
  } finally {clearTimeout(timer);}
}
function renderLogs() {
  updateLogDownload();
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
$('logNode')?.addEventListener('change',event=>{
  selected=event.target.value;renderGraph();renderSentinels();renderFleet();renderInspector();syncLogControls();
  if(typeof syncWorkspaceLocation==='function'&&!sharedView)syncWorkspaceLocation(activeCluster,selected);
});
$('logFilter')?.addEventListener('input',renderLogs);
$('logDownload')?.addEventListener('click',downloadLogs);
$('logPause')?.addEventListener('click',()=>{
  logPaused=!logPaused;
  $('logPause').textContent=logPaused?'Resume':'Pause';$('logPause').setAttribute('aria-pressed',String(logPaused));
  renderLogs();if(!logPaused)fetchLogs();
});
$('logFollow')?.addEventListener('click',()=>{
  logFollowing=!logFollowing;
  $('logFollow').textContent=logFollowing?'Following ↓':'Follow ↓';$('logFollow').setAttribute('aria-pressed',String(logFollowing));
  if(logFollowing)$('logOutput').scrollTop=$('logOutput').scrollHeight;
});
// Cached reads do not create additional SSH sessions for browser tabs.
if($('logNode')) {
  setInterval(fetchLogs,2000);
  setInterval(()=>{if(!logPaused&&logPayload)renderLogs();},1000);
}
