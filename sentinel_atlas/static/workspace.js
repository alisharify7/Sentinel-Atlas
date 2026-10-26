'use strict';

function syncWorkspaceLocation(cluster,node) {
  const current=new URL(window.location.href);
  current.searchParams.set('cluster',cluster);
  if(node)current.searchParams.set('node',node);else current.searchParams.delete('node');
  if(current.href!==window.location.href)history.replaceState(null,'',current);
  document.querySelectorAll('[data-cluster-link]').forEach(link=>{
    const target=new URL(link.href);
    target.searchParams.set('cluster',cluster);
    if(node)target.searchParams.set('node',node);else target.searchParams.delete('node');
    link.href=target.href;
  });
}

function graphStorageKey(cluster) {
  return `atlas:layout:${document.body.dataset.layoutKey}:${cluster}`;
}
function loadGraphPositions(cluster) {
  try {
    const entries=JSON.parse(sessionStorage.getItem(graphStorageKey(cluster))||'[]');
    if(!Array.isArray(entries))return [];
    return entries.slice(0,2000).filter(entry=>Array.isArray(entry)&&entry.length===2&&typeof entry[0]==='string'&&
      entry[1]&&Number.isFinite(entry[1].x)&&Number.isFinite(entry[1].y)&&Math.abs(entry[1].x)<=1000000&&Math.abs(entry[1].y)<=1000000);
  } catch {return [];}
}
function persistGraphPositions(cluster,positions) {
  try {sessionStorage.setItem(graphStorageKey(cluster),JSON.stringify([...positions]));} catch { /* Browsing with storage disabled still supports dragging. */ }
}

const workspaceTimezone=document.body.dataset.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone;
let workspaceDateFormatter;
try {workspaceDateFormatter=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:workspaceTimezone});}
catch {workspaceDateFormatter=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'});}
function formatWorkspaceDate(timestamp) {return workspaceDateFormatter.format(new Date(timestamp*1000));}
document.querySelectorAll('time[data-timestamp]').forEach(element=>{
  const date=new Date(Number(element.dataset.timestamp)*1000);
  element.dateTime=date.toISOString();
  element.textContent=formatWorkspaceDate(Number(element.dataset.timestamp));
  element.title=`${date.toISOString()} · ${workspaceTimezone}`;
});
document.querySelectorAll('[data-share-path]').forEach(input=>{input.value=new URL(input.dataset.sharePath,window.location.origin).href;});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-copy-input]');
  if(!button)return;
  const input=document.getElementById(button.dataset.copyInput),status=document.querySelector('.copy-status');
  try {await navigator.clipboard.writeText(input.value);if(status)status.textContent='Link copied.';}
  catch {input.focus();input.select();if(status)status.textContent='Link selected. Copy it using your keyboard.';}
});
