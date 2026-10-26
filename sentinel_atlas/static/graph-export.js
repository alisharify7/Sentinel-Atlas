'use strict';

let graphExportBusy=false;

// A standalone SVG keeps exports portable: no page CSS, external fonts, or HTML.
function graphExportSnapshot() {
  if(!graphLayout?.nodes.length) throw Error('There are no Redis nodes to download.');
  const {nodes,positions,cardWidth,cardHeight}=graphLayout;
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  positions.forEach(p=>{left=Math.min(left,p.x);top=Math.min(top,p.y);right=Math.max(right,p.x+cardWidth);bottom=Math.max(bottom,p.y+cardHeight);});
  const width=Math.max(560,right-left+80),height=bottom-top+208;
  const now=new Date(), cluster=state.cluster||'Redis cluster';
  const filename=`${cluster.replace(/[^a-zA-Z0-9_-]+/g,'-').slice(0,80).replace(/^-+|-+$/g,'')||'redis'}-topology-${now.toISOString().replace(/[:.]/g,'-')}`;
  const text=(x,y,value,size=11,fill='#dce8fa',extra='')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(value)}</text>`;
  const cards=nodes.map((node,index)=>{
    const p=positions.get(node.name),r=node.redis,kind=role(node),sync=syncView(node);
    const accent=kind==='master'?'#72e4c9':kind==='down'||kind==='unknown'?'#f08b9c':'#83b8f8';
    const background=kind==='master'?'#173a3c':kind==='down'||kind==='unknown'?'#362839':'#1b2e47';
    const tone=sync.tone==='error'?'#ffb9c5':sync.tone==='warning'?'#f0c98a':sync.tone==='ready'?'#92ddca':'#a9bfdb';
    const clip=`export-card-${index}`;
    const status=!r.up?'Unavailable':r.loading?'Loading dataset':kind==='master'?'Accepting writes':r.syncing?'Synchronizing':r.link==='up'?'Replication connected':'Replication link down';
    const metrics=[['MEMORY',r.up?bytes(r.memory_used):'—'],['OPS / SEC',r.up?fmt(r.ops_per_second):'—'],['CLIENTS',r.up?fmt(r.clients):'—']];
    return `<g transform="translate(${p.x},${p.y})"><title>${esc(`${node.name} · ${endpoint(node)} · ${kind}`)}</title><rect width="${cardWidth}" height="${cardHeight}" rx="11" fill="${background}" stroke="${accent}" stroke-width="1.5"/><path d="M12 1H${cardWidth-12}" stroke="${accent}" stroke-width="3"/><defs><clipPath id="${clip}"><rect x="14" y="10" width="${cardWidth-28}" height="${cardHeight-20}"/></clipPath></defs><g clip-path="url(#${clip})">
      ${text(16,26,'REDIS INSTANCE',8,'#9db5d2','letter-spacing="1"')}${text(16,52,node.name,17,'#f0f5ff','font-weight="700"')}${text(cardWidth-16,26,kind.toUpperCase(),8,accent,'text-anchor="end"')}${text(16,73,endpoint(node),10,'#a9bfdb')}
      <path d="M16 88H${cardWidth-16}" stroke="#36516e"/>
      ${metrics.map(([label,value],i)=>text(16+i*74,106,label,8,'#a5bbd5')+text(16+i*74,126,value,12,'#e0eaf8')).join('')}
      ${text(16,153,sync.title,11,tone,'font-weight="600"')}${text(16,171,sync.description,9,'#b6cce6')}
      ${sync.progress!=null?`<rect x="16" y="180" width="${cardWidth-32}" height="4" rx="2" fill="#36516e"/><rect x="16" y="180" width="${(cardWidth-32)*Math.max(0,Math.min(100,sync.progress))/100}" height="4" rx="2" fill="${tone}"/>`:''}
      <path d="M16 199H${cardWidth-16}" stroke="#36516e"/>${text(16,219,status,9,r.up?tone:'#ffb9c5')}
      </g></g>`;
  }).join('');
  const observation=state.updated_at?new Date(state.updated_at*1000).toISOString():now.toISOString();
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="export-title export-desc">
    <title id="export-title">${esc(cluster)} replication topology</title><desc id="export-desc">${nodes.length} Redis nodes with observed replication links. Node positions match the dashboard layout.</desc>
    <style>text{font-family:Arial,Helvetica,sans-serif}.edge{fill:none;stroke:#71a8df;stroke-width:2}.edge.down{stroke:#f08b9c;stroke-dasharray:5 5}.arrow-fill{fill:#71a8df}.arrow-fill.down{fill:#f08b9c}.edge-label-bg{fill:#14243a;stroke:#36516e}.edge-label{font-size:8px;fill:#ffb9c5}</style>
    <rect width="${width}" height="${height}" fill="#0f1d32"/>
    ${text(32,35,'SENTINEL ATLAS / REPLICATION TOPOLOGY',10,'#9db5d2','letter-spacing="1.4"')}${text(32,64,cluster,22,'#f0f5ff','font-weight="700"')}${text(32,85,`${nodes.length} Redis nodes · ${state.mode==='demo'?'Demo data':serverConnected?'Cluster snapshot':'Last observation'} · ${observation}`,10,'#a9bfdb')}
    <g transform="translate(${40-left},${128-top})">${graphEdgeMarkup(graphLayout,false)}${cards}</g>
    ${text(32,height-44,`Master → replicas · Captured ${now.toISOString()}`,10,'#a9bfdb')}
    ${text(32,height-23,'Open source by Ali Sharify · @alisharify7 · ali-sharify.ir',10,'#a9bfdb')}
    </svg>`;
  return {svg,width,height,filename};
}

async function graphExportCanvas(snapshot) {
  const image=new Image();
  image.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(snapshot.svg)}`;
  await image.decode();
  // Bound memory use for large clusters, while rendering ordinary maps at 2x.
  const scale=Math.min(2,8192/snapshot.width,8192/snapshot.height,Math.sqrt(16000000/(snapshot.width*snapshot.height)));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.floor(snapshot.width*scale));canvas.height=Math.max(1,Math.floor(snapshot.height*scale));
  const context=canvas.getContext('2d');
  if(!context) throw Error('This browser could not create an image. Try SVG instead.');
  context.drawImage(image,0,0,canvas.width,canvas.height);
  return canvas;
}

function graphCanvasBlob(canvas,type) {
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('Image export failed. Try SVG instead.')),type,.95));
}

// A single JPEG image in a standard PDF page needs no server or PDF dependency.
function graphImagePdf(jpeg,width,height) {
  const landscape=width>=height,pageWidth=landscape?841.89:595.28,pageHeight=landscape?595.28:841.89;
  const scale=Math.min((pageWidth-48)/width,(pageHeight-48)/height),w=width*scale,h=height*scale;
  const content=`q\n${w.toFixed(4)} 0 0 ${h.toFixed(4)} ${((pageWidth-w)/2).toFixed(4)} ${((pageHeight-h)/2).toFixed(4)} cm\n/Graph Do\nQ\n`;
  const encoder=new TextEncoder(),chunks=[],offsets=[0];let length=0;
  const add=value=>{const data=typeof value==='string'?encoder.encode(value):value;chunks.push(data);length+=data.length;};
  const object=(id,body)=>{offsets[id]=length;add(`${id} 0 obj\n${body}\nendobj\n`);};
  add('%PDF-1.4\n');
  object(1,'<< /Type /Catalog /Pages 2 0 R >>');
  object(2,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Graph 5 0 R >> >> /Contents 4 0 R >>`);
  object(4,`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`);
  offsets[5]=length;
  add(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  add(jpeg);add('\nendstream\nendobj\n');
  const xref=length;
  add('xref\n0 6\n0000000000 65535 f \n');
  for(let id=1;id<=5;id++) add(`${String(offsets[id]).padStart(10,'0')} 00000 n \n`);
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks,{type:'application/pdf'});
}

async function downloadGraph(format) {
  if(graphExportBusy) return;
  if(!['svg','png','pdf'].includes(format)) return;
  const status=$('graphExportStatus'),menu=$('graphExport');
  graphExportBusy=true;status.hidden=false;status.classList.remove('error');status.textContent=`Preparing ${format.toUpperCase()}…`;
  menu.querySelectorAll('button').forEach(button=>{button.disabled=true;});
  menu.removeAttribute('open');
  try {
    // Capture synchronously so polling cannot mix observations during encoding.
    const snapshot=graphExportSnapshot();
    let blob;
    if(format==='svg') blob=new Blob([snapshot.svg],{type:'image/svg+xml;charset=utf-8'});
    else {
      const canvas=await graphExportCanvas(snapshot);
      if(format==='png') blob=await graphCanvasBlob(canvas,'image/png');
      else {const jpeg=await graphCanvasBlob(canvas,'image/jpeg');blob=graphImagePdf(new Uint8Array(await jpeg.arrayBuffer()),canvas.width,canvas.height);}
    }
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=`${snapshot.filename}.${format}`;
    document.body.append(link);link.click();link.remove();
    // Allow the browser to consume the URL before releasing its backing data.
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    status.textContent=`${format.toUpperCase()} download ready.`;
  } catch(error) {
    status.classList.add('error');status.textContent=error.message||'Download failed. Please try again.';
  } finally {
    graphExportBusy=false;
    menu.querySelectorAll('button').forEach(button=>{button.disabled=false;});
  }
}
