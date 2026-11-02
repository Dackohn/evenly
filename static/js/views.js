// Page rendering: sidebar plus one main view at a time. Everything is plain template strings;
// any user-provided text must pass through esc().
import {$, CAT, CATS, CURS, FREQ, MONTHS, ROLES, centsStr, dateTime, esc, fmt, fmtShort, hueOf, iso, parseISO} from './util.js';
import {S, addTo, avatar, canWrite, computeAll, friendNet, groupList, handleOf, isOwner, meId, memberNet, myTotals,
  nm, nonZero, peopleList, verbS, who, whoFull} from './state.js';

/* ---------- icons ---------- */
const IC = {
  dashboard:'<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  activity:'<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  all:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  insights:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  group:'<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.2 3.2 0 0 1 0 6.3M18 14.3c1.8.8 3 2.7 3 5.7"/>',
  nogroup:'<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12h8"/>',
};
export const icon = k => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[k]}</svg>`;
export const BRAND = `<span class="mark"><svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true"><rect x="0" y="1" width="16" height="3" rx="1.5"/><rect x="0" y="8" width="16" height="3" rx="1.5"/></svg></span>Evenly`;

function balText(map, friend){
  const nz = nonZero(map);
  if (!nz.length) return `<span class="mut">settled up</span>`;
  return nz.map(([c,v])=>`<span class="${v>0?'pos':'neg'}">${v>0?(friend?'owes you ':'you are owed '):'you owe '}${fmt(Math.abs(v),c)}</span>`).join('<br>');
}
const handleTag = pid => { const h = handleOf(pid); return h ? ` <span class="tag acct" title="Linked to this account">${esc(h)}</span>` : ''; };

// "Which person are you?" picker. People linked to another account are shown but cannot be picked.
export function meSelect(id){
  const me = meId();
  const opts = peopleList().map(p=>{
    const other = p.userId && p.userId!==S.user.id;
    return `<option value="${p.id}"${p.id===me?' selected':''}${other?' disabled':''}>${esc(p.name)}${other?` (${esc(handleOf(p.id))})`:''}</option>`;
  }).join('');
  return `<select id="${id}" data-change="me" aria-label="Which person are you"><option value=""${me?'':' selected'} disabled>Choose your name…</option>${opts}<option value="__new">I am not in the list — add me</option></select>`;
}

/* ---------- sidebar ---------- */
function renderSide(){
  const v = S.view, me = meId();
  const navItem = (name,label) => `<button class="item${v.name===name?' on':''}" data-act="nav" data-view="${name}">${icon(name)}<span class="lbl">${label}</span></button>`;
  const groups = groupList();
  const hasNoGroup = (S.calc.byG['']||[]).length > 0;
  const balBadge = nz => me && nz.length ? `<span class="bal ${nz[0][1]>0?'pos':'neg'}">${nz[0][1]>0?'+':'−'}${fmtShort(Math.abs(nz[0][1]),nz[0][0])}${nz.length>1?' …':''}</span>` : '';
  const gItems = groups.map(g=>`<button class="item${v.name==='group'&&v.id===g.id?' on':''}" data-act="nav" data-view="group" data-id="${g.id}">${icon('group')}<span class="lbl">${esc(g.name)}</span>${balBadge(nonZero(myTotals(e=>e.gid===g.id).net))}</button>`).join('')
    + (hasNoGroup ? `<button class="item${v.name==='group'&&v.id===''?' on':''}" data-act="nav" data-view="group" data-id="">${icon('nogroup')}<span class="lbl">Non-group expenses</span></button>` : '');
  const fItems = peopleList().filter(p=>p.id!==me).map(p=>`<button class="item${v.name==='friend'&&v.id===p.id?' on':''}" data-act="nav" data-view="friend" data-id="${p.id}">${avatar(p.id,true)}<span class="lbl">${esc(p.name)}</span>${balBadge(nonZero(friendNet(p.id)))}</button>`).join('');
  $('#side').innerHTML = `<div class="side-in">
    <div class="brand">${BRAND}</div>
    <nav class="nav" aria-label="Views">${navItem('dashboard','Dashboard')}${navItem('activity','Recent activity')}${navItem('all','All expenses')}${navItem('insights','Insights')}${navItem('settings','Settings')}</nav>
    <div class="side-sec"><div class="side-h">Groups${canWrite()?'<button class="mini" data-act="add-group">+ New</button>':''}</div>${gItems || '<div class="side-empty">No groups yet</div>'}</div>
    <div class="side-sec"><div class="side-h">Friends${canWrite()?'<button class="mini" data-act="add-person">+ Add</button>':''}</div>${fItems || '<div class="side-empty">No friends yet</div>'}</div>
  </div>
  <div class="side-foot">
    ${S.ledgers.length>1 ? `<label for="ledger-sel">Ledger</label><select id="ledger-sel" data-change="ledger">${S.ledgers.map(l=>`<option value="${l.id}"${l.id===S.lid?' selected':''}>${esc(l.name)}</option>`).join('')}</select>` : `<b>${esc(S.ledger?.name||'')}</b>`}
    <label for="me-sel">You are</label>${meSelect('me-sel')}
    <div class="mode">Signed in as ${esc(S.user.name)} (@${esc(S.user.username)})</div>
  </div>`;
}

/* ---------- main ---------- */
export function render(){
  if (!S.loaded) return;
  computeAll();
  if (S.view.name==='group' && S.view.id && (!S.groups[S.view.id] || S.groups[S.view.id].deleted)) S.view = {name:'dashboard'};
  if (S.view.name==='friend' && !S.people[S.view.id]) S.view = {name:'dashboard'};
  renderSide();
  const views = {activity:viewActivity, all:viewAll, insights:viewInsights, group:viewGroup, friend:viewFriend, settings:viewSettings};
  const html = (views[S.view.name] || viewDashboard)();
  const banner = !canWrite() ? `<div class="note warn"><p>You can view this ledger but not change it. Ask an owner to give you edit access.</p></div>` : '';
  const view = $('#view');
  // keep focus and caret in search boxes across re-renders
  const ae = document.activeElement; const focusId = ae && view.contains(ae) ? ae.id : null; const sel = focusId && ae.selectionStart;
  view.innerHTML = banner + html;
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); try { if (sel!=null) el.setSelectionRange(sel, sel); } catch {} } }
  $('#fab').hidden = !canWrite() || !peopleList().length;
}

function header(eyebrow, title, actions){
  return `<header class="vh"><div style="min-width:0">${eyebrow?`<div class="eyebrow">${eyebrow}</div>`:''}<h1>${title}</h1></div><div class="vh-act">${actions||''}</div></header>`;
}
function stdActions(extra){
  if (!canWrite() || !peopleList().length) return extra||'';
  return `<button class="btn primary" data-act="add-expense">+ Add expense</button><button class="btn" data-act="settle">Settle up</button>${extra||''}`;
}

/* dashboard */
function viewDashboard(){
  const people = peopleList(); const me = meId();
  let html = header(esc(S.ledger.name), me ? `Hi, ${esc(S.people[me].name)}` : 'Dashboard', stdActions());
  if (!me) html += `<div class="note info"><p>Which person in this ledger are you? Balances are shown from your side, and everyone can see which account each person belongs to.</p>${meSelect('me-sel2')}</div>`;
  if (Object.values(S.people).some(p=>p.example) || Object.values(S.groups).some(g=>g.example && !g.deleted))
    html += `<div class="note info"><p>The example trip is loaded. Its people and expenses are made up.</p>${canWrite()?'<button class="btn sm" data-act="clear-example">Remove example data</button>':''}</div>`;
  if (!groupList().length && !S.calc.list.length) html += `<section class="card hello">
    <div class="l"><h2>Split costs with friends and see who owes whom.</h2>
      <p>Create a group for a trip, a flat or a night out, add the people in it, and log what each person paid. Invite friends from Settings so they can sign in and see the same balances.</p>
      ${canWrite() ? `<div class="inline"><button class="btn primary" data-act="add-group">Create a group</button><button class="btn" data-act="nav" data-view="settings">Invite people</button></div>
      <p style="font-size:13px">Just looking? <button class="link" data-act="example">Load an example trip</button>, then remove it when you are done.</p>` : '<p>Nothing has been added yet.</p>'}
    </div>
    <div class="r"><b>What you can do</b><ul>
      <li>Split equally, by exact amounts, percentages, shares or with adjustments</li>
      <li>Several people can pay for one expense</li>
      <li>Simplify debts so the group makes the fewest payments</li>
      <li>Repeat monthly bills such as rent and internet automatically</li>
      <li>Keep balances in more than one currency, with MDL, EUR, USD and more</li>
      <li>Attach receipt photos and comment on expenses</li>
      <li>Charts by category and month, a monthly budget, and CSV export</li>
    </ul></div></section>`;
  const t = myTotals();
  const lines = (map, sign) => { const nz = nonZero(map); return nz.length ? nz.map(([c,v])=>`<small class="${sign==='net'?(v>0?'pos':'neg'):sign}">${sign==='net'&&v>0?'+':sign==='net'?'−':''}${fmt(Math.abs(v),c)}</small>`).join('') : `<small class="mut">${fmt(0, S.prefs.currency||'MDL')}</small>`; };
  html += `<section class="strip" aria-label="Your balances">
    <div><span class="k">Total balance</span><span class="v">${lines(t.net,'net')}</span></div>
    <div><span class="k">You owe</span><span class="v">${lines(t.owe,'neg')}</span></div>
    <div><span class="k">You are owed</span><span class="v">${lines(t.owed,'pos')}</span></div></section>`;
  const owe = [], owed = [];
  if (me) for (const p of people) { if (p.id===me) continue; for (const [c,v] of nonZero(friendNet(p.id))) (v>0?owed:owe).push({p, c, v:Math.abs(v)}); }
  const fr = (r, dir) => `<div class="prow">${avatar(r.p.id)}<div class="who"><b>${esc(r.p.name)}</b><span>${dir==='owe'?'you owe':'owes you'}</span></div><div class="amt ${dir==='owe'?'neg':'pos'}">${fmt(r.v,r.c)}</div>
    ${canWrite()?`<button class="btn sm" data-act="settle" data-from="${dir==='owe'?me:r.p.id}" data-to="${dir==='owe'?r.p.id:me}" data-amt="${r.v}" data-cur="${r.c}">Settle</button>`:''}</div>`;
  html += `<div class="grid2">
    <section class="card"><div class="card-h"><h2>You owe</h2></div><div class="rows">${owe.sort((a,b)=>b.v-a.v).map(r=>fr(r,'owe')).join('') || `<div class="empty"><p>${me?'You do not owe anyone.':'Choose who you are to see this.'}</p></div>`}</div></section>
    <section class="card"><div class="card-h"><h2>You are owed</h2></div><div class="rows">${owed.sort((a,b)=>b.v-a.v).map(r=>fr(r,'owed')).join('') || `<div class="empty"><p>${me?'Nobody owes you right now.':'Choose who you are to see this.'}</p></div>`}</div></section></div>`;
  const gs = groupList();
  if (gs.length) html += `<section class="card"><div class="card-h"><h2>Groups</h2>${canWrite()?'<button class="btn sm" data-act="add-group">+ New group</button>':''}</div><div class="rows">${
    gs.map(g=>{ const n = (S.calc.byG[g.id]||[]).filter(e=>e.type!=='payment').length; return `<button class="prow item" style="border-radius:0" data-act="nav" data-view="group" data-id="${g.id}"><span class="avs">${g.memberIds.slice(0,4).map(id=>avatar(id,true)).join('')}</span><span class="who"><b>${esc(g.name)}</b><span>${esc(g.kind||'Group')} · ${g.memberIds.length} people · ${n} expense${n===1?'':'s'}</span></span><span class="amt">${me?balText(myTotals(e=>e.gid===g.id).net):''}</span></button>`; }).join('')}</div></section>`;
  const recent = S.calc.list.slice(0,6);
  html += `<section class="card"><div class="card-h"><h2>Latest expenses</h2><button class="btn sm ghost" data-act="nav" data-view="all">See all</button></div>${recent.length ? `<div class="rows">${recent.map(e=>expRow(e,true)).join('')}</div>` : `<div class="empty"><p>No expenses yet. Add the first one with “Add expense”.</p></div>`}</section>`;
  return html;
}

/* expense row */
function expRow(e, showGroup){
  const me = meId(); const d = parseISO(e.date);
  const cat = CAT[e.category] || CAT.other;
  const gname = showGroup ? (e.groupId ? S.groups[e.groupId]?.name : 'Non-group') : '';
  const gtag = gname ? ` · ${esc(gname)}` : '';
  if (e.type==='payment') {
    const [from] = Object.keys(e.paid); const [to] = Object.keys(e.owed);
    const mine = from===me ? `<span class="mut">you paid</span>` : to===me ? `<span class="mut">you received</span>` : '';
    return `<button class="xrow pay" data-act="open-expense" data-id="${e.id}"><span class="dt"><small>${MONTHS[d.getMonth()]}</small><b>${d.getDate()}</b></span><span class="sw" style="background:var(--pos)"></span>
      <span class="t"><b>${esc(nm(from,true))} paid ${esc(nm(to))}</b><span>Payment${gtag}${e.notes?` · ${esc(e.notes)}`:''}</span></span><span class="r"><b>${fmt(e.amount,e.currency)}</b>${mine}</span></button>`;
  }
  const payers = Object.keys(e.paid||{});
  const paidTxt = payers.length===1 ? `${esc(nm(payers[0],true))} paid ${fmt(e.amount,e.currency)}` : `${payers.length} people paid ${fmt(e.amount,e.currency)}`;
  let right = `<span class="mut">not involved</span>`;
  if (me && ((e.paid||{})[me] || (e.owed||{})[me])) {
    const net = ((e.paid||{})[me]||0) - ((e.owed||{})[me]||0);
    right = net>0 ? `<span class="pos">you lent</span><b class="pos">${fmt(net,e.currency)}</b>` : net<0 ? `<span class="neg">you borrowed</span><b class="neg">${fmt(-net,e.currency)}</b>` : `<span class="mut">your share</span><b>${fmt((e.owed||{})[me]||0,e.currency)}</b>`;
  }
  return `<button class="xrow" data-act="open-expense" data-id="${e.id}"><span class="dt"><small>${MONTHS[d.getMonth()]}</small><b>${d.getDate()}</b></span><span class="sw" style="background:${cat.c}" title="${esc(cat.l)}"></span>
    <span class="t"><b>${esc(e.desc)}${e.recurringId?'<span class="tag rec">repeats</span>':''}${e.receiptId?'<span class="tag">receipt</span>':''}${(e.comments||[]).length?`<span class="tag">${e.comments.length} comment${e.comments.length>1?'s':''}</span>`:''}</b><span>${paidTxt}${gtag}</span></span><span class="r">${right}</span></button>`;
}
function monthList(list, showGroup){
  if (!list.length) return '';
  let html = '', cur = '';
  for (const e of list) { const k = e.date.slice(0,7); if (k!==cur) { cur = k; const d = parseISO(k+'-01'); html += `<div class="month">${d.toLocaleString(undefined,{month:'long',year:'numeric'})}</div>`; } html += expRow(e, showGroup); }
  return html;
}
export function filterList(list, f){
  const q = (f.q||'').trim().toLowerCase();
  return list.filter(e => (f.gid==='*' || (e.groupId||'')===f.gid) && (f.cat==='*' || (f.cat==='payment' ? e.type==='payment' : e.category===f.cat && e.type!=='payment'))
    && (f.pid==='*' || (e.paid||{})[f.pid]!=null || (e.owed||{})[f.pid]!=null)
    && (!q || (e.desc||'').toLowerCase().includes(q) || (e.notes||'').toLowerCase().includes(q) || String(e.amount/100).includes(q)));
}

/* all expenses */
function viewAll(){
  const f = S.filt;
  const list = filterList(S.calc.list, f);
  let html = header('Ledger', 'All expenses', stdActions(`<button class="btn" data-act="export">Export CSV</button>`));
  html += `<div class="toolbar"><input type="search" id="flt-q" data-input="q" placeholder="Search description, notes or amount" value="${esc(f.q)}" aria-label="Search">
    <select id="flt-g" data-change="fgid" aria-label="Group"><option value="*">All groups</option>${groupList().map(g=>`<option value="${g.id}"${f.gid===g.id?' selected':''}>${esc(g.name)}</option>`).join('')}<option value=""${f.gid===''?' selected':''}>Non-group</option></select>
    <select id="flt-c" data-change="fcat" aria-label="Category"><option value="*">All categories</option>${CATS.map(c=>`<option value="${c.k}"${f.cat===c.k?' selected':''}>${c.l}</option>`).join('')}<option value="payment"${f.cat==='payment'?' selected':''}>Payments</option></select>
    <select id="flt-p" data-change="fpid" aria-label="Person"><option value="*">Anyone</option>${peopleList(true).map(p=>`<option value="${p.id}"${f.pid===p.id?' selected':''}>${esc(p.name)}</option>`).join('')}</select></div>`;
  const totals = {}; list.filter(e=>e.type!=='payment').forEach(e=>addTo(totals,e.currency,e.amount));
  html += `<p class="mut" style="margin:0">${list.length} item${list.length===1?'':'s'}${nonZero(totals).length?' · spent '+nonZero(totals).map(([c,v])=>fmt(v,c)).join(' + '):''}</p>`;
  html += `<section class="card">${list.length ? monthList(list, true) : `<div class="empty"><p>No expenses match these filters.</p></div>`}</section>`;
  return html;
}

/* activity: derived from the audit fields on each record */
function viewActivity(){
  const items = [];
  for (const [id,e] of Object.entries(S.expenses)) {
    const g = e.groupId ? S.groups[e.groupId] : null; if (g?.deleted) continue;
    items.push({t:e.createdAt||0, id, e, verb: e.auto ? 'repeated' : 'added', by:e.createdBy});
    if (e.updatedAt && e.updatedAt - (e.createdAt||0) > 2000 && !e.deleted) items.push({t:e.updatedAt, id, e, verb:'updated', by:e.updatedBy});
    if (e.deleted) items.push({t:e.deletedAt||e.updatedAt||0, id, e, verb:'deleted', by:e.deletedBy});
  }
  for (const [id,g] of Object.entries(S.groups)) items.push({t:(g.deleted?g.updatedAt:g.createdAt)||0, gid:id, g, verb: g.deleted?'deleted group':'created group', by: g.deleted ? g.updatedBy : g.createdBy});
  items.sort((a,b)=>b.t-a.t);
  let html = header('Activity', 'Recent activity', stdActions());
  const rows = items.slice(0,100).map(it=>{
    const when = it.t ? dateTime(it.t) : '';
    if (it.g) return `<div class="prow">${icon('group')}<div class="who"><b>${esc(whoFull(it.by))} ${it.verb} “${esc(it.g.name)}”</b><span>${when}</span></div></div>`;
    const e = it.e; const gname = e.groupId ? S.groups[e.groupId]?.name : 'Non-group';
    const label = e.type==='payment' ? `a payment from ${esc(nm(Object.keys(e.paid)[0]))} to ${esc(nm(Object.keys(e.owed)[0]))}` : `“${esc(e.desc)}”`;
    const act = it.verb==='deleted' ? (canWrite() && e.deleted ? `<button class="btn sm" data-act="restore-expense" data-id="${it.id}">Restore</button>` : '') : (!e.deleted ? `<button class="btn sm ghost" data-act="open-expense" data-id="${it.id}">View</button>` : '');
    return `<div class="prow"><span class="sw" style="background:${e.type==='payment'?'var(--pos)':(CAT[e.category]||CAT.other).c};flex:none"></span><div class="who"><b style="white-space:normal">${esc(whoFull(it.by))} ${it.verb} ${label}</b><span>${esc(gname||'')} · ${fmt(e.amount,e.currency)} · ${when}</span></div>${act}</div>`;
  }).join('');
  html += `<section class="card"><div class="rows">${rows || '<div class="empty"><p>Nothing has happened yet.</p></div>'}</div></section>`;
  return html;
}

/* group */
function viewGroup(){
  const gid = S.view.id; const g = gid ? S.groups[gid] : {name:'Non-group expenses', memberIds: peopleList().map(p=>p.id), currency:S.prefs.currency||'MDL', kind:'Between friends'};
  const tab = S.view.tab || 'expenses'; const me = meId();
  const list = S.calc.byG[gid] || [];
  let html = header(esc(g.kind||'Group'), esc(g.name), stdActions());
  const members = g.memberIds.filter(id=>S.people[id]);
  html += `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span class="avs">${members.slice(0,8).map(id=>avatar(id,true)).join('')}</span><span class="mut" style="font-size:14px">${members.map(id=>esc(nm(id,false))).join(', ')}</span>${me?`<span style="margin-left:auto;text-align:right;font-weight:600">${balText(myTotals(e=>e.gid===gid).net)}</span>`:''}</div>`;
  const tabs = [['expenses','Expenses'],['balances','Balances'],['totals','Totals']].concat(gid?[['settings','Settings']]:[]);
  html += `<div class="tabs" role="tablist">${tabs.map(([k,l])=>`<button role="tab" aria-selected="${tab===k}" class="${tab===k?'on':''}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}</div>`;
  if (tab==='expenses') {
    const q = S.view.q || '';
    const fl = filterList(list, {q, gid:'*', cat:'*', pid:'*'});
    html += `<div class="toolbar"><input type="search" id="g-q" data-input="gq" placeholder="Search this group" value="${esc(q)}" aria-label="Search this group"></div>`;
    html += `<section class="card">${fl.length ? monthList(fl, false) : `<div class="empty"><h3>${list.length?'No matches':'No expenses yet'}</h3><p>${list.length?'Try a different search.':'Add what someone paid, and Evenly works out who owes whom.'}</p>${!list.length&&canWrite()?'<button class="btn primary" data-act="add-expense">Add the first expense</button>':''}</div>`}</section>`;
  }
  if (tab==='balances') {
    const B = memberNet(gid); const curs = Object.keys(B);
    const edges = S.calc.edges.filter(e=>e.gid===gid);
    html += `<div class="grid2"><section class="card"><div class="card-h"><h2>Who is up, who is down</h2></div><div class="rows">${
      members.map(id=>{ const vals = curs.map(c=>[c,B[c][id]||0]).filter(([,v])=>v);
        return `<div class="prow">${avatar(id)}<div class="who"><b>${esc(nm(id,true))}</b><span>${vals.length?(vals.some(([,v])=>v>0)?'gets back':'owes'):'settled up'}</span></div><div class="amt">${vals.map(([c,v])=>`<div class="${v>0?'pos':'neg'}">${v>0?'+':'−'}${fmt(Math.abs(v),c)}</div>`).join('') || '<span class="mut">—</span>'}</div></div>`; }).join('')}</div></section>
      <section class="card"><div class="card-h"><h2>Suggested payments</h2><span class="pill ${gid&&g.simplify!==false?'pos':'z'}">${gid&&g.simplify!==false?'Simplified':'Not simplified'}</span></div><div class="rows">${
      edges.map(x=>`<div class="prow"><div class="who"><b style="white-space:normal">${esc(nm(x.from,true))} ${verbS(x.from,'pay','pays')} ${esc(nm(x.to))}</b></div><div class="amt">${fmt(x.amt,x.cur)}</div>${canWrite()?`<button class="btn sm" data-act="settle" data-from="${x.from}" data-to="${x.to}" data-amt="${x.amt}" data-cur="${x.cur}" data-gid="${gid}">Record</button>`:''}</div>`).join('')
      || '<div class="empty"><p>Everyone is settled up.</p></div>'}</div>
      ${gid?`<div class="card-b mut" style="font-size:13px;border-top:1px solid var(--line)">${g.simplify!==false?'Debts are combined so the group makes as few payments as possible. You can turn this off in Settings.':'Each person pays back the people who paid for them. Turn on simplified debts in Settings to reduce the number of payments.'}</div>`:''}</section></div>`;
  }
  if (tab==='totals') html += totalsBlock(list.filter(e=>e.type!=='payment'));
  if (tab==='settings' && gid) {
    const recs = Object.entries(S.recurring).filter(([,r])=>r.groupId===gid && r.active);
    html += `<div class="grid2"><section class="card"><div class="card-h"><h2>Group details</h2>${canWrite()?'<button class="btn sm" data-act="edit-group">Edit</button>':''}</div><div class="card-b"><dl class="kv">
      <dt>Name</dt><dd>${esc(g.name)}</dd><dt>Type</dt><dd>${esc(g.kind||'Other')}</dd><dt>Currency</dt><dd>${esc(g.currency)}</dd>
      <dt>Simplify debts</dt><dd>${g.simplify!==false?'On':'Off'}</dd><dt>Members</dt><dd>${members.map(id=>esc(nm(id,true))).join(', ')}</dd>
      <dt>Created</dt><dd>${esc(whoFull(g.createdBy))}${g.createdAt?', '+dateTime(g.createdAt):''}</dd></dl></div></section>
      <section class="card"><div class="card-h"><h2>Repeating expenses</h2></div><div class="rows">${recs.map(([rid,r])=>`<div class="prow"><div class="who"><b>${esc(r.template.desc)}</b><span>${FREQ[r.freq]} · next on ${parseISO(r.nextDate).toLocaleDateString(undefined,{dateStyle:'medium'})}</span></div><div class="amt">${fmt(r.template.amount,r.template.currency)}</div>${canWrite()?`<button class="btn sm" data-act="stop-recur" data-id="${rid}">Stop</button>`:''}</div>`).join('') || '<div class="empty"><p>None. When you add an expense, open “Notes, receipt, repeat” and pick how often it repeats.</p></div>'}</div></section></div>
      <section class="card"><div class="card-h"><h2>Export and delete</h2></div><div class="card-b" style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" data-act="export" data-gid="${gid}">Export this group as CSV</button>${canWrite()?'<button class="btn danger" data-act="del-group">Delete group</button>':''}</div></section>`;
  }
  return html;
}
function totalsBlock(list){
  const me = meId(); const tot = {}, mine = {}, paidMe = {};
  for (const e of list) { addTo(tot,e.currency,e.amount); if (me) { addTo(mine,e.currency,(e.owed||{})[me]||0); addTo(paidMe,e.currency,(e.paid||{})[me]||0); } }
  const curs = Object.keys(tot);
  if (!curs.length) return `<section class="card"><div class="empty"><p>No spending recorded yet.</p></div></section>`;
  const cur = curs.sort((a,b)=>tot[b]-tot[a])[0];
  const l = list.filter(e=>e.currency===cur);
  const byCat = {}; l.forEach(e=>addTo(byCat,e.category||'other',e.amount));
  const byPerson = {}; l.forEach(e=>{ for (const [p,v] of Object.entries(e.owed||{})) addTo(byPerson,p,v); });
  const max = Math.max(...Object.values(byPerson));
  const fmtL = m => nonZero(m).map(([c,v])=>fmt(v,c)).join(' + ') || fmt(0,cur);
  return `<section class="strip"><div><span class="k">Group spending</span><span class="v">${fmtL(tot)}</span></div><div><span class="k">Your share</span><span class="v">${me?fmtL(mine):'—'}</span></div><div><span class="k">You paid</span><span class="v">${me?fmtL(paidMe):'—'}</span></div></section>
    <div class="grid2"><section class="card"><div class="card-h"><h2>By category</h2><span class="mut" style="font-size:13px">${cur}</span></div><div class="card-b">${catBars(byCat, cur)}</div></section>
    <section class="card"><div class="card-h"><h2>Share per person</h2><span class="mut" style="font-size:13px">${cur}</span></div><div class="card-b"><div class="bars">${
      Object.entries(byPerson).sort((a,b)=>b[1]-a[1]).map(([p,v])=>`<div class="bar-row"><span class="lab">${avatar(p,true)}<span>${esc(nm(p,true))}</span></span><div class="track"><div class="fill" style="width:${(v/max*100).toFixed(1)}%;background:hsl(${hueOf(p)} 42% 50%)"></div></div><span class="num">${fmt(v,cur)}</span></div>`).join('')}</div></div></section></div>`;
}
function catBars(byCat, cur){
  const tot = Object.values(byCat).reduce((a,b)=>a+b,0);
  const rows = Object.entries(byCat).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
  if (!rows.length) return '<p class="mut" style="margin:0">Nothing in this period.</p>';
  const max = rows[0][1];
  return `<div class="bars">${rows.map(([k,v])=>{ const c = CAT[k]||CAT.other; return `<div class="bar-row"><span class="lab"><span class="sw" style="background:${c.c};flex:none"></span><span>${c.l}</span></span><div class="track"><div class="fill" style="width:${(v/max*100).toFixed(1)}%;background:${c.c}"></div></div><span class="num">${fmt(v,cur)} <span class="mut">${Math.round(v/tot*100)}%</span></span></div>`; }).join('')}</div>`;
}

/* friend */
function viewFriend(){
  const pid = S.view.id; const p = S.people[pid]; const me = meId();
  const net = me ? friendNet(pid) : {};
  const linkedToOther = p.userId && p.userId!==S.user.id;
  let html = header('Friend', esc(p.name) + handleTag(pid), stdActions(canWrite() && !linkedToOther ? `<button class="btn" data-act="edit-person" data-id="${pid}">Edit</button>` : ''));
  html += `<p class="mut" style="margin:0;font-size:14px">${p.userId ? `Signed in to Evenly as ${esc(handleOf(pid))}. Only they can change their name.` : `No account yet. Added by ${esc(whoFull(p.createdBy))}.`}</p>`;
  if (!me) html += `<div class="note info"><p>Choose who you are to see what you and ${esc(p.name)} owe each other.</p>${meSelect('me-sel3')}</div>`;
  else {
    const nz = nonZero(net);
    const byGroup = {};
    for (const e of S.calc.edges) { const k = e.gid; if (e.from===pid&&e.to===me) addTo(byGroup[k] ??= {}, e.cur, e.amt); if (e.from===me&&e.to===pid) addTo(byGroup[k] ??= {}, e.cur, -e.amt); }
    html += `<section class="card"><div class="card-h"><h2>${nz.length ? nz.map(([c,v])=>v>0?`<span class="pos">${esc(p.name)} owes you ${fmt(v,c)}</span>`:`<span class="neg">You owe ${esc(p.name)} ${fmt(-v,c)}</span>`).join('<br>') : 'You are settled up'}</h2>
      ${nz.length&&canWrite()?`<button class="btn primary" data-act="settle" data-from="${nz[0][1]>0?pid:me}" data-to="${nz[0][1]>0?me:pid}" data-amt="${Math.abs(nz[0][1])}" data-cur="${nz[0][0]}">Settle up</button>`:''}</div>
      <div class="rows">${Object.entries(byGroup).filter(([,m])=>nonZero(m).length).map(([gid,m])=>`<div class="prow">${icon(gid?'group':'nogroup')}<div class="who"><b>${esc(gid?S.groups[gid]?.name:'Non-group expenses')}</b></div><div class="amt">${balText(m, true)}</div></div>`).join('')}</div></section>`;
  }
  const shared = S.calc.list.filter(e=>{ const inv = id => (e.paid||{})[id]!=null || (e.owed||{})[id]!=null; return inv(pid) && (!me || inv(me)); });
  html += `<section class="card">${shared.length ? monthList(shared, true) : `<div class="empty"><p>No shared expenses with ${esc(p.name)} yet.</p></div>`}</section>`;
  if (canWrite() && !p.userId) html += `<div><button class="btn danger sm" data-act="del-person" data-id="${pid}">Remove ${esc(p.name)}</button></div>`;
  if (isOwner() && linkedToOther) html += `<div><button class="btn sm" data-act="unlink-person" data-id="${pid}">Unlink ${esc(handleOf(pid))} from ${esc(p.name)}</button></div>`;
  return html;
}

/* insights */
function periodStart(k){
  const d = new Date(); d.setHours(0,0,0,0);
  if (k==='1m') return iso(new Date(d.getFullYear(), d.getMonth(), 1));
  if (k==='lm') return iso(new Date(d.getFullYear(), d.getMonth()-1, 1));
  if (k==='3m') return iso(new Date(d.getFullYear(), d.getMonth()-2, 1));
  if (k==='12m') return iso(new Date(d.getFullYear(), d.getMonth()-11, 1));
  if (k==='y') return iso(new Date(d.getFullYear(), 0, 1));
  return '0000-00-00';
}
function periodEnd(k){ const d = new Date(); return k==='lm' ? iso(new Date(d.getFullYear(), d.getMonth(), 0)) : '9999-12-31'; }
function niceMax(v){ const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1,2,2.5,5,10]) if (m*p >= v) return m*p; return 10*p; }
function viewInsights(){
  const f = S.ins; const me = meId();
  const all = S.calc.list.filter(e=>e.type!=='payment' && (f.gid==='*' || (e.groupId||'')===f.gid));
  const curCount = {}; all.forEach(e=>addTo(curCount,e.currency,1));
  const curs = Object.keys(curCount).sort((a,b)=>curCount[b]-curCount[a]);
  if (!f.cur || !curCount[f.cur]) f.cur = curs[0] || S.prefs.currency || 'MDL';
  const cur = f.cur;
  const basisMine = f.basis==='mine' && me;
  const val = e => basisMine ? ((e.owed||{})[me]||0) : e.amount;
  const st = periodStart(f.period), en = periodEnd(f.period);
  const list = all.filter(e=>e.currency===cur && e.date>=st && e.date<=en);
  const total = list.reduce((a,e)=>a+e.amount,0);
  const mine = me ? list.reduce((a,e)=>a+((e.owed||{})[me]||0),0) : 0;
  const paid = me ? list.reduce((a,e)=>a+((e.paid||{})[me]||0),0) : 0;
  const byCat = {}; list.forEach(e=>addTo(byCat,e.category||'other',val(e)));
  const now = new Date(); const months = [];
  for (let i=11; i>=0; i--) { const d = new Date(now.getFullYear(), now.getMonth()-i, 1); months.push({k:iso(d).slice(0,7), label:MONTHS[d.getMonth()], total:0, mine:0}); }
  const mi = Object.fromEntries(months.map((m,i)=>[m.k,i]));
  all.filter(e=>e.currency===cur).forEach(e=>{ const i = mi[e.date.slice(0,7)]; if (i!=null) { months[i].total += e.amount; months[i].mine += me ? ((e.owed||{})[me]||0) : 0; } });
  const payers = {}; list.forEach(e=>{ for (const [p,v] of Object.entries(e.paid||{})) addTo(payers,p,v); });
  const bCur = S.prefs.budgetCur || cur; const budget = S.prefs.budget || 0;
  const mStart = periodStart('1m');
  const spentMonth = me ? S.calc.list.filter(e=>e.type!=='payment' && e.currency===bCur && e.date>=mStart).reduce((a,e)=>a+((e.owed||{})[me]||0),0) : 0;
  const daysIn = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const pace = Math.round(spentMonth / now.getDate() * daysIn);

  let html = header('Insights', 'Where the money goes', `<button class="btn" data-act="export">Export CSV</button>`);
  html += `<div class="toolbar">
    <select id="ins-p" data-change="ins-period" aria-label="Period">${[['1m','This month'],['lm','Last month'],['3m','Last 3 months'],['12m','Last 12 months'],['y','This year'],['all','All time']].map(([k,l])=>`<option value="${k}"${f.period===k?' selected':''}>${l}</option>`).join('')}</select>
    <select id="ins-g" data-change="ins-gid" aria-label="Group"><option value="*">All groups</option>${groupList().map(g=>`<option value="${g.id}"${f.gid===g.id?' selected':''}>${esc(g.name)}</option>`).join('')}<option value=""${f.gid===''?' selected':''}>Non-group</option></select>
    <select id="ins-c" data-change="ins-cur" aria-label="Currency">${(curs.length?curs:[cur]).map(c=>`<option${c===cur?' selected':''}>${c}</option>`).join('')}</select>
    <div class="seg" role="group" aria-label="Count">${[['all','Whole cost'],['mine','My share']].map(([k,l])=>`<button type="button" class="${(f.basis===k)?'on':''}" data-act="ins-basis" data-k="${k}"${k==='mine'&&!me?' disabled title="Choose who you are first"':''}>${l}</button>`).join('')}</div></div>`;
  html += `<section class="strip"><div><span class="k">Total spending</span><span class="v">${fmt(total,cur)}<small class="mut">${list.length} expense${list.length===1?'':'s'}</small></span></div>
    <div><span class="k">Your share</span><span class="v">${me?fmt(mine,cur):'—'}${me&&total?`<small class="mut">${Math.round(mine/total*100)}% of the total</small>`:''}</span></div>
    <div><span class="k">You paid</span><span class="v">${me?fmt(paid,cur):'—'}${me?`<small class="${paid-mine>=0?'pos':'neg'}">${paid-mine>=0?'covered others':'others covered you'} by ${fmt(Math.abs(paid-mine),cur)}</small>`:''}</span></div></section>`;
  const mx = niceMax(Math.max(1, ...months.map(m=>basisMine?m.mine:m.total)));
  const W = 640, H = 220, pl = 52, pr = 6, pt = 10, pb = 26, ih = H-pt-pb, bw = (W-pl-pr)/12;
  const y = v => pt + ih - v/mx*ih;
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spending per month, last 12 months, ${cur}">`;
  for (const t of [0, .5, 1]) svg += `<line class="g" x1="${pl}" x2="${W-pr}" y1="${y(mx*t)}" y2="${y(mx*t)}"/><text class="tx" x="${pl-8}" y="${y(mx*t)+4}" text-anchor="end">${esc(fmtShort(mx*t,cur))}</text>`;
  months.forEach((m,i)=>{ const x = pl + i*bw + bw*.18, w = bw*.64;
    if (!basisMine) svg += `<rect class="b1" x="${x}" y="${y(m.total)}" width="${w}" height="${Math.max(0,ih-(y(m.total)-pt))}" rx="3"><title>${m.label}: ${esc(fmt(m.total,cur))} total</title></rect>`;
    if (me) svg += `<rect class="b2" x="${x+(basisMine?0:w*.22)}" y="${y(m.mine)}" width="${basisMine?w:w*.56}" height="${Math.max(0,ih-(y(m.mine)-pt))}" rx="3"><title>${m.label}: ${esc(fmt(m.mine,cur))} your share</title></rect>`;
    svg += `<text class="tx" x="${x+w/2}" y="${H-8}" text-anchor="middle">${m.label}</text>`; });
  svg += `</svg>`;
  html += `<div class="grid2"><section class="card"><div class="card-h"><h2>Last 12 months</h2><div class="legend">${!basisMine?'<span><i style="background:var(--bar)"></i>Whole cost</span>':''}${me?'<span><i style="background:var(--accent)"></i>Your share</span>':''}</div></div><div class="card-b">${svg}</div></section>
    <section class="card"><div class="card-h"><h2>By category</h2><span class="mut" style="font-size:13px">${basisMine?'your share':'whole cost'}</span></div><div class="card-b">${catBars(byCat,cur)}</div></section></div>`;
  html += `<div class="grid2"><section class="card"><div class="card-h"><h2>Monthly budget</h2><span class="mut" style="font-size:13px">your share, this month</span></div><div class="card-b" style="display:flex;flex-direction:column;gap:12px">${
    !me ? '<p class="mut" style="margin:0">Choose who you are to track a budget.</p>' :
    (budget ? `<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><b class="num">${fmt(spentMonth,bCur)} of ${fmt(budget,bCur)}</b><span class="${spentMonth>budget?'neg':'mut'}">${spentMonth>budget?`${fmt(spentMonth-budget,bCur)} over`:`${fmt(budget-spentMonth,bCur)} left`}</span></div>
      <div class="meter${spentMonth>budget?' over':''}"><div style="width:${Math.min(100,spentMonth/budget*100).toFixed(1)}%"></div></div>
      <p class="mut" style="margin:0;font-size:13px">At this pace you will spend about ${fmt(pace,bCur)} by the end of the month${pace>budget?', which is over budget':''}.</p>` : '<p class="mut" style="margin:0">Set a limit for your share of spending each month. Only you see your budget.</p>') +
    `<form class="inline" id="budget-form"><input id="bud-amt" inputmode="decimal" placeholder="Monthly limit" value="${budget?centsStr(budget):''}" aria-label="Monthly limit"><select id="bud-cur" aria-label="Budget currency">${CURS.map(c=>`<option${c===bCur?' selected':''}>${c}</option>`).join('')}</select><button class="btn" type="submit">Save</button></form>`}</div></section>
    <section class="card"><div class="card-h"><h2>Who paid most</h2></div><div class="rows">${Object.entries(payers).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([p,v])=>`<div class="prow">${avatar(p,true)}<div class="who"><b>${esc(nm(p,true))}</b><span>${total?Math.round(v/total*100):0}% of spending</span></div><div class="amt">${fmt(v,cur)}</div></div>`).join('') || '<div class="empty"><p>Nothing in this period.</p></div>'}</div></section></div>`;
  return html;
}

/* settings: account, this ledger, members and invite link */
export const inviteUrl = tok => location.origin + location.pathname + '#join=' + encodeURIComponent(tok);
function viewSettings(){
  const me = meId(); const L = S.ledger;
  let html = header('Settings', 'Settings');
  html += `<div class="grid2">
    <section class="card"><div class="card-h"><h2>Your account</h2></div><div class="card-b" style="display:flex;flex-direction:column;gap:14px">
      <dl class="kv"><dt>Username</dt><dd>@${esc(S.user.username)}</dd></dl>
      <form class="inline" id="profile-form"><label class="fld" style="flex:1">Your name, as others see it<input id="pr-name" maxlength="40" value="${esc(S.user.name)}" autocomplete="name"></label><button class="btn" type="submit" style="align-self:flex-end">Save</button></form>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="change-password">Change password</button><button class="btn" data-act="logout">Sign out</button></div>
    </div></section>
    <section class="card"><div class="card-h"><h2>You in “${esc(L.name)}”</h2></div><div class="card-b" style="display:flex;flex-direction:column;gap:12px">
      <label class="fld">You are${meSelect('me-sel4')}</label>
      <p class="mut" style="margin:0;font-size:13px">Your account is linked to one person in this ledger. Everyone can see which account each person belongs to, and nobody else can pick the person linked to you.</p>
      ${me ? `<form class="inline" id="person-name-form"><label class="fld" style="flex:1">Your name in this ledger<input id="pn-name" maxlength="40" value="${esc(S.people[me].name)}"></label><button class="btn" type="submit" style="align-self:flex-end">Save</button></form>` : ''}
    </div></section></div>`;
  const ownerCount = S.members.filter(m=>m.role==='owner').length;
  html += `<section class="card"><div class="card-h"><h2>People with access</h2><span class="mut" style="font-size:13px">${S.members.length} account${S.members.length===1?'':'s'}</span></div><div class="rows">${
    S.members.map(m=>{
      const linked = Object.entries(S.people).find(([,p])=>p.userId===m.userId)?.[1];
      const self = m.userId===S.user.id;
      const roleCtl = isOwner() && !(self && m.role==='owner' && ownerCount===1)
        ? `<select data-change="role" data-uid="${m.userId}" aria-label="Access for ${esc(m.name)}">${Object.entries(ROLES).map(([k,l])=>`<option value="${k}"${k===m.role?' selected':''}>${l}</option>`).join('')}</select>`
        : `<span class="pill z">${ROLES[m.role]}</span>`;
      const rm = self ? (m.role==='owner' && ownerCount===1 ? '' : `<button class="btn sm danger" data-act="leave-ledger">Leave</button>`)
        : isOwner() ? `<button class="btn sm danger" data-act="remove-member" data-uid="${m.userId}">Remove</button>` : '';
      return `<div class="prow"><span class="av" style="background:hsl(${hueOf(m.userId)} 42% 44%)" aria-hidden="true">${esc(m.name.slice(0,1).toUpperCase())}</span><div class="who"><b>${esc(m.name)}${self?' (you)':''} <span class="mut" style="font-weight:500">@${esc(m.username)}</span></b><span>${linked?`appears as “${esc(linked.name)}”`:'has not picked a person yet'} · joined ${new Date(m.joinedAt).toLocaleDateString(undefined,{dateStyle:'medium'})}</span></div>${roleCtl}${rm}</div>`;
    }).join('')}</div>
    ${isOwner() ? `<div class="card-b" style="border-top:1px solid var(--line);display:flex;flex-direction:column;gap:10px">
      <b>Invite link</b>
      ${L.inviteToken ? `<p class="mut" style="margin:0;font-size:13px">Anyone with this link can create an account and join this ledger with edit access. Share it only with the people you mean to invite, and turn it off when everyone has joined.</p>
        <div class="inline"><input id="invite-url" readonly value="${esc(inviteUrl(L.inviteToken))}" aria-label="Invite link"><button class="btn primary" data-act="copy-invite">Copy</button></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" data-act="new-invite">Make a new link</button><button class="btn sm danger" data-act="stop-invite">Turn off the link</button></div>`
      : `<p class="mut" style="margin:0;font-size:13px">The invite link is off. Nobody new can join.</p><div><button class="btn sm" data-act="new-invite">Create an invite link</button></div>`}
    </div>` : `<div class="card-b mut" style="border-top:1px solid var(--line);font-size:13px">Ask an owner for an invite link to bring someone new in.</div>`}</section>`;
  html += `<section class="card"><div class="card-h"><h2>Ledgers</h2></div><div class="card-b" style="display:flex;flex-direction:column;gap:12px">
    <p class="mut" style="margin:0;font-size:13px">A ledger is a private space with its own people, groups and access list. Use separate ledgers for circles that should not see each other’s expenses.</p>
    ${S.ledgers.length>1?`<label class="fld">Open ledger<select data-change="ledger" id="ledger-sel2">${S.ledgers.map(l=>`<option value="${l.id}"${l.id===S.lid?' selected':''}>${esc(l.name)}</option>`).join('')}</select></label>`:''}
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="new-ledger">+ New ledger</button>${isOwner()?'<button class="btn" data-act="rename-ledger">Rename this ledger</button><button class="btn danger" data-act="delete-ledger">Delete this ledger</button>':''}</div>
  </div></section>`;
  return html;
}

/* screen shown when the account belongs to no ledger yet */
export function renderNoLedger(){
  $('#side').innerHTML = `<div class="side-in"><div class="brand">${BRAND}</div></div><div class="side-foot"><div class="mode">Signed in as ${esc(S.user.name)} (@${esc(S.user.username)})</div><button class="btn sm" data-act="logout">Sign out</button></div>`;
  $('#fab').hidden = true;
  $('#view').innerHTML = header('', `Welcome, ${esc(S.user.name)}`) + `<section class="card hello"><div class="l"><h2>Start a ledger</h2>
    <p>A ledger holds the groups, people and expenses you share with one circle of friends. You can invite them once it exists.</p>
    <form class="inline" id="ledger-form"><input id="ledger-name" maxlength="60" placeholder="e.g. Friends, Flat 12, Family" aria-label="Ledger name"><button class="btn primary" type="submit">Create</button></form>
    </div><div class="r"><b>Were you invited?</b><p class="mut" style="margin:0">Open the invite link you were sent while signed in, and you will join that ledger.</p></div></section>`;
}
