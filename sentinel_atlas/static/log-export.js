'use strict';

function logExportSnapshot(data,{filter='',mode='live',now=new Date()}={}) {
  if(!data||!['redis','sentinel'].includes(data.service)||!Array.isArray(data.lines)||!data.lines.length)throw Error('No collected log lines are available to download.');
  const query=filter.toLowerCase(),lines=data.lines.filter(line=>line.toLowerCase().includes(query));
  if(!lines.length)throw Error('No log lines match your filter. Clear the filter to download the collected tail.');
  const captured=now.toISOString(),observed=new Date(data.updated_at*1000);
  const timestamp=data.updated_at&&Number.isFinite(observed.getTime())?observed.toISOString():null;
  const node=String(data.node||'redis').replace(/[^a-zA-Z0-9_-]+/g,'-').slice(0,80).replace(/^-+|-+$/g,'')||'redis';
  const filename=`${node}-${data.service}-${(timestamp||captured).replace(/[:.]/g,'-')}${filter?'-filtered':''}.log`;
  const stale=data.stale||!timestamp||now.getTime()/1000-data.updated_at>Math.max(20,(data.poll_interval||5)*4);
  // Quote untrusted metadata so it cannot create extra header lines. Log content
  // is the same credential-redacted text already supplied to the console.
  const header=[
    '# Sentinel Atlas · service log snapshot',
    `# Node: ${JSON.stringify(String(data.node||''))}`,
    `# Service: ${data.service}`,
    `# Source: ${JSON.stringify(String(data.source||'Unknown source'))}`,
    `# Observed at (UTC): ${timestamp||'Unknown'}`,
    `# Downloaded at (UTC): ${captured}`,
    `# Status: ${JSON.stringify(String(data.status||'unknown'))}${stale?' · stale observation':''}`,
    `# Scope: latest collected tail (up to 120 lines); ${lines.length} of ${data.lines.length} collected lines`,
    `# Filter: ${filter?JSON.stringify(filter):'None'}`,
    ...(mode==='demo'?['# Demo sample data · no live infrastructure contacted']:[])
  ];
  return {filename,text:header.join('\n')+'\n\n'+lines.join('\n')+'\n',lineCount:lines.length};
}

function downloadLogSnapshot(snapshot) {
  const blob=new Blob([snapshot.text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
  try {
    link.href=url;link.download=snapshot.filename;
    document.body.append(link);link.click();
  } finally {
    link.remove();
    // Browsers may consume the object URL after the click handler returns.
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
}
