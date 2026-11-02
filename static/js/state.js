// App state, identity helpers and balance math. Views read from S; all writes go through mutate().
import {api} from './api.js';
import {allocate, esc, hueOf, initials} from './util.js';

export const S = {
  user:null, ledgers:[], lid:null,             // signed-in account and the ledgers it belongs to
  ledger:null, role:'viewer', members:[], profiles:{}, receipts:{},
  people:{}, groups:{}, expenses:{}, recurring:{}, prefs:{},
  loaded:false, version:0,
  view:{name:'dashboard', id:null, tab:'expenses'},
  filt:{q:'', gid:'*', cat:'*', pid:'*'}, ins:{period:'3m', gid:'*', cur:null, basis:'all'},
  calc:null,
};

let renderFn = () => {};
export const setRenderer = fn => { renderFn = fn; };
export const render = () => renderFn();
export const canWrite = () => S.role==='owner' || S.role==='editor';
export const isOwner = () => S.role==='owner';
export const L = path => `ledgers/${S.lid}/${path}`;   // ledger-scoped API path

export async function reload(){
  if (!S.lid) return;
  const st = await api('GET', L('state'));
  Object.assign(S, {ledger:st.ledger, role:st.role, prefs:st.prefs, members:st.members, profiles:st.profiles,
    people:st.people, groups:st.groups, expenses:st.expenses, recurring:st.recurring, receipts:st.receipts,
    version:st.ledger.version, loaded:true});
  render();
}
// Run a write, then refresh from the server so every view shows what was actually stored.
export async function mutate(method, path, body){
  const res = await api(method, L(path), body);
  await reload();
  return res;
}

/* ---------- people & identity ---------- */
export const meId = () => Object.entries(S.people).find(([,p])=>p.userId && p.userId===S.user?.id && !p.deleted)?.[0] || null;
export const peopleList = (all) => Object.entries(S.people).map(([id,p])=>({id,...p})).filter(p=>all||!p.deleted).sort((a,b)=>a.name.localeCompare(b.name));
export const groupList = () => Object.entries(S.groups).map(([id,g])=>({id,...g})).filter(g=>!g.deleted).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
export function nm(pid, start){
  if (pid && pid===meId()) return start ? 'You' : 'you';
  const p = S.people[pid]; if (!p) return 'Someone';
  return p.name + (p.deleted ? ' (removed)' : '');
}
export const verbS = (pid, plain, third) => pid===meId() ? plain : third; // "you owe" / "Ana owes"
// The account a person is linked to, e.g. "@ana" — shown so everyone can tell who is who.
export const handleOf = pid => { const u = S.people[pid]?.userId; return u && S.profiles[u] ? '@'+S.profiles[u].username : ''; };
export function who(uid){
  if (!uid) return 'Someone';
  if (uid===S.user?.id) return 'You';
  return S.profiles[uid]?.name || 'A former member';
}
export function whoFull(uid){
  const p = S.profiles[uid];
  return uid===S.user?.id || !p ? who(uid) : `${p.name} (@${p.username})`;
}
export function avatar(pid, sm){ const p = S.people[pid]; return `<span class="av${sm?' sm':''}" style="background:hsl(${hueOf(pid)} 42% 44%)" aria-hidden="true">${esc(initials(p?.name))}</span>`; }

/* ---------- ledger math ---------- */

export function activeExpenses(){
  return Object.entries(S.expenses).map(([id,e])=>({id,...e}))
    .filter(e=>!e.deleted && (!e.groupId || (S.groups[e.groupId] && !S.groups[e.groupId].deleted)))
    .sort((a,b)=> b.date.localeCompare(a.date) || (b.createdAt||0)-(a.createdAt||0));
}
export function netBal(list){
  const B = {};
  for (const e of list) {
    const m = (B[e.currency] ??= {});
    for (const [p,v] of Object.entries(e.paid||{})) m[p] = (m[p]||0) + v;
    for (const [p,v] of Object.entries(e.owed||{})) m[p] = (m[p]||0) - v;
  }
  return B;
}
// Greedy debt simplification: largest debtor pays largest creditor until everyone is square.
function simplifyBal(B){
  const out = [];
  for (const [cur,m] of Object.entries(B)) {
    const cr = [], db = [];
    for (const [p,v] of Object.entries(m)) { if (v>0) cr.push([p,v]); else if (v<0) db.push([p,-v]); }
    while (cr.length && db.length) {
      cr.sort((a,b)=>b[1]-a[1]); db.sort((a,b)=>b[1]-a[1]);
      const x = Math.min(db[0][1], cr[0][1]);
      out.push({cur, from:db[0][0], to:cr[0][0], amt:x});
      db[0][1] -= x; cr[0][1] -= x;
      if (!db[0][1]) db.shift(); if (!cr[0][1]) cr.shift();
    }
  }
  return out;
}
// Unsimplified: each person owes the people who actually paid for them, netted per pair.
function pairEdges(list){
  const M = {};
  for (const e of list) {
    const m = (M[e.currency] ??= {});
    const payers = Object.entries(e.paid||{}).filter(([,v])=>v>0); if (!payers.length) continue;
    for (const [d,ow] of Object.entries(e.owed||{})) {
      if (ow<=0) continue;
      for (const [p,c] of Object.entries(allocate(ow, payers))) { if (p===d || !c) continue; m[d+'|'+p] = (m[d+'|'+p]||0) + c; }
    }
  }
  const out = [];
  for (const [cur,m] of Object.entries(M)) {
    const seen = new Set();
    for (const k of Object.keys(m)) {
      const [a,b] = k.split('|'); const key = a<b ? a+'|'+b : b+'|'+a; if (seen.has(key)) continue; seen.add(key);
      const v = (m[a+'|'+b]||0) - (m[b+'|'+a]||0);
      if (v>0) out.push({cur,from:a,to:b,amt:v}); else if (v<0) out.push({cur,from:b,to:a,amt:-v});
    }
  }
  return out;
}
export function computeAll(){
  const list = activeExpenses();
  const byG = {};
  for (const e of list) (byG[e.groupId||''] ??= []).push(e);
  const edges = [];
  for (const [gid,l] of Object.entries(byG)) {
    const g = S.groups[gid];
    const es = (gid && g && g.simplify!==false) ? simplifyBal(netBal(l)) : pairEdges(l);
    for (const x of es) { x.gid = gid; edges.push(x); }
  }
  S.calc = {list, byG, edges};
}
export function addTo(map, cur, v){ map[cur] = (map[cur]||0) + v; }
export function myTotals(filter){
  const me = meId(); const owe = {}, owed = {}, net = {};
  if (!me) return {owe, owed, net};
  for (const e of S.calc.edges) {
    if (filter && !filter(e)) continue;
    if (e.from===me) { addTo(owe,e.cur,e.amt); addTo(net,e.cur,-e.amt); }
    if (e.to===me) { addTo(owed,e.cur,e.amt); addTo(net,e.cur,e.amt); }
  }
  return {owe, owed, net};
}
export function friendNet(pid){ // >0: friend owes me
  const me = meId(); const net = {};
  for (const e of S.calc.edges) {
    if (e.from===pid && e.to===me) addTo(net,e.cur,e.amt);
    if (e.from===me && e.to===pid) addTo(net,e.cur,-e.amt);
  }
  return net;
}
export const memberNet = gid => netBal(S.calc.byG[gid]||[]);
export const nonZero = map => Object.entries(map).filter(([,v])=>v);
