// Entry point: session and ledger loading, event dispatch, background refresh.
import {api, setUnauthorizedHandler} from './api.js';
import {$, CAT, centsStr, esc, parseMoney, toast, todayISO} from './util.js';
import {S, meId, mutate, nm, peopleList, reload, setRenderer} from './state.js';
import {filterList, inviteUrl, render, renderNoLedger} from './views.js';
import {askConfirm, askText, closeDialog, formActions, openDetail, openExpense, openGroup, openPassword, openPerson, openSettle} from './dialogs.js';
import {showAuth} from './auth.js';

const LAST_LEDGER = 'evenly-ledger';
const store = {get:k=>{ try { return localStorage.getItem(k); } catch { return null; } }, set:(k,v)=>{ try { localStorage.setItem(k,v); } catch {} }};
setRenderer(render);

/* ---------- session & ledgers ---------- */
async function loadMe(){
  const me = await api('GET', 'me');
  S.user = me.user; S.ledgers = me.ledgers;
}
async function openLedger(lid){
  S.lid = lid || null; S.loaded = false; S.view = {name:'dashboard', id:null, tab:'expenses'};
  S.filt = {q:'', gid:'*', cat:'*', pid:'*'}; S.ins = {period:'3m', gid:'*', cur:null, basis:'all'};
  closeDialog();
  if (!lid) return renderNoLedger();
  store.set(LAST_LEDGER, lid);
  $('#view').innerHTML = '<p class="loading">Opening your ledger…</p>';
  await reload();
}
const joinToken = () => new URLSearchParams(location.hash.slice(1)).get('join');
const clearHash = () => history.replaceState(null, '', location.pathname + location.search);

async function boot(invite){
  await loadMe();
  let lid = S.ledgers.find(l=>l.id===store.get(LAST_LEDGER))?.id || S.ledgers[0]?.id;
  if (invite) {
    try {
      if (!S.ledgers.some(l=>l.id===invite.ledgerId)) { await api('POST', `invites/${encodeURIComponent(invite.token)}/accept`); await loadMe(); toast(`You joined ${invite.ledgerName}`); }
      lid = invite.ledgerId;
    } catch (e) { toast(e.message); }
    clearHash();
  }
  await openLedger(lid);
}
async function start(){
  let invite = null;
  const tok = joinToken();
  if (tok) {
    try { invite = {token:tok, ...(await api('GET', 'invites/'+encodeURIComponent(tok)))}; }
    catch (e) { clearHash(); setTimeout(()=>toast(e.message), 300); }
  }
  pendingInvite = invite;
  try { await boot(invite); pendingInvite = null; }
  catch (e) {
    if (e.status===401) return requireAuth();
    $('#view').innerHTML = `<div class="note warn"><p>${esc(e.message)}</p><button class="btn sm" data-act="reload-page">Try again</button></div>`;
  }
}
// Any 401 (first load or an expired session) lands here; the flag keeps it to one sign-in screen.
let authShown = false, pendingInvite = null;
function requireAuth(){
  if (authShown) return;
  authShown = true; S.loaded = false; closeDialog();
  const invite = pendingInvite;
  showAuth(invite, ()=>{ authShown = false; pendingInvite = null; boot(invite).catch(er=>toast(er.message)); });
}
setUnauthorizedHandler(requireAuth);

// See other people's changes: poll a cheap version counter, fetch everything only when it moved.
async function poll(){
  if (document.visibilityState!=='visible' || !S.lid || !S.loaded || authShown) return;
  try { const {version} = await api('GET', `ledgers/${S.lid}/version`); if (version!==S.version) await reload(); } catch {}
}
setInterval(poll, 10000);
document.addEventListener('visibilitychange', poll);

/* ---------- CSV export ---------- */
function exportCSV(gid){
  const list = gid!=null ? (S.calc.byG[gid]||[]) : S.view.name==='all' ? filterList(S.calc.list, S.filt) : S.calc.list;
  const q = v => `"${String(v??'').replace(/"/g,'""')}"`;
  const rows = [['Date','Type','Description','Category','Group','Currency','Amount','Paid by','Split between','Notes'].map(q).join(',')];
  for (const e of [...list].reverse()) {
    rows.push([e.date, e.type, e.type==='payment'?`${nm(Object.keys(e.paid)[0],true)} paid ${nm(Object.keys(e.owed)[0])}`:e.desc, e.type==='payment'?'Payment':(CAT[e.category]||CAT.other).l,
      e.groupId?S.groups[e.groupId]?.name:'Non-group', e.currency, centsStr(e.amount),
      Object.entries(e.paid).map(([p,v])=>`${S.people[p]?.name||'?'}: ${centsStr(v)}`).join('; '),
      Object.entries(e.owed).map(([p,v])=>`${S.people[p]?.name||'?'}: ${centsStr(v)}`).join('; '), e.notes||''].map(q).join(','));
  }
  const name = (gid ? S.groups[gid]?.name : S.ledger.name) || 'expenses';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿'+rows.join('\r\n')], {type:'text/csv;charset=utf-8'}));
  a.download = (name.replace(/[^\w\- ]+/g,'').trim().replace(/\s+/g,'-').toLowerCase() || 'expenses') + '-' + todayISO() + '.csv';
  document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
}

/* ---------- identity ---------- */
async function chooseMe(value){
  if (value==='__new') {
    render(); // reset the select while the dialog is open
    return askText({title:'Add yourself', label:'Your name in this ledger', value:S.user.name, maxlength:40, button:'Add me',
      save: async name => { await mutate('POST', 'people', {name, claim:true}); toast('You are now in this ledger'); }});
  }
  const p = S.people[value]; if (!p) return;
  if (!await askConfirm(`Are you ${esc(p.name)}?`, `Your account (@${esc(S.user.username)}) will be linked to ${esc(p.name)}. Everyone in this ledger will see this, and their balances will be shown as yours.`, 'Yes, that is me')) return render();
  try { await mutate('POST', `people/${value}/claim`); toast(`You are ${p.name}`); } catch (e) { toast(e.message); render(); }
}

/* ---------- click actions ---------- */
const run = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
const ACT = {
  ...formActions,
  'nav': d => { S.view = {name:d.view, id:d.id ?? null, tab:'expenses'}; render(); window.scrollTo(0,0); },
  'tab': d => { S.view.tab = d.tab; render(); },
  'add-expense': () => { if (!peopleList().length) return toast('Add people first.'); openExpense(null); },
  'edit-expense': d => openExpense(d.id),
  'open-expense': d => openDetail(d.id),
  'del-expense': run(async d => {
    const e = S.expenses[d.id];
    if (!await askConfirm(e.type==='payment'?'Delete this payment?':`Delete “${esc(e.desc)}”?`, 'Balances will update. You can restore it from Recent activity.', 'Delete')) return;
    await mutate('PATCH', `expenses/${d.id}`, {deleted:true}); toast('Deleted. Restore it from Recent activity.');
  }),
  'restore-expense': run(async d => { await mutate('PATCH', `expenses/${d.id}`, {deleted:false}); toast('Restored'); }),
  'settle': d => openSettle({from:d.from, to:d.to, amt:d.amt, cur:d.cur, gid:d.gid}),
  'add-group': () => openGroup(null),
  'edit-group': () => openGroup(S.view.id),
  'del-group': run(async () => {
    const g = S.groups[S.view.id];
    const open = S.calc.edges.some(e=>e.gid===S.view.id);
    if (!await askConfirm(`Delete “${esc(g.name)}”?`, open ? 'Some people in this group still owe money. Deleting the group removes those balances from everyone’s totals.' : 'The group and its expenses will no longer appear.', 'Delete group')) return;
    const gid = S.view.id; S.view = {name:'dashboard'};
    await mutate('PATCH', `groups/${gid}`, {deleted:true}); toast('Group deleted');
  }),
  'add-person': () => openPerson(null),
  'edit-person': d => openPerson(d.id),
  'del-person': run(async d => {
    if (S.calc.edges.some(e=>e.from===d.id||e.to===d.id)) return toast(`${nm(d.id,true)} still has a balance. Settle up first.`);
    if (!await askConfirm(`Remove ${esc(S.people[d.id].name)}?`, 'Past expenses keep their name. They will no longer appear in lists or new expenses.', 'Remove')) return;
    S.view = {name:'dashboard'};
    await mutate('PATCH', `people/${d.id}`, {deleted:true});
  }),
  'unlink-person': run(async d => {
    if (!await askConfirm('Unlink this account?', `${esc(S.people[d.id].name)} will no longer be tied to an account, and anyone in the ledger could pick it. Use this only if the wrong person claimed it.`, 'Unlink')) return;
    await mutate('PATCH', `people/${d.id}`, {unlink:true}); toast('Unlinked');
  }),
  'stop-recur': run(async d => { await mutate('PATCH', `recurring/${d.id}`, {active:false}); toast('This expense will no longer repeat'); }),
  'export': d => exportCSV(d.gid ?? (S.view.name==='insights' ? null : undefined)),
  'example': run(async () => { const r = await mutate('POST', 'example'); S.view = {name:'group', id:r.groupId, tab:'expenses'}; render(); toast('Example trip loaded'); }),
  'clear-example': run(async () => {
    if (!await askConfirm('Remove example data?', 'This deletes the example group, its expenses and the made-up people. Your own data stays.', 'Remove')) return;
    S.view = {name:'dashboard'}; await mutate('DELETE', 'example'); toast('Example data removed');
  }),
  'close-dlg': () => closeDialog(),
  'ins-basis': d => { S.ins.basis = d.k; render(); },
  'reload-page': () => location.reload(),
  // account
  'logout': run(async () => { await api('POST', 'auth/logout'); location.replace(location.pathname); }),
  'change-password': () => openPassword(),
  // ledger & members
  'copy-invite': run(async () => { const v = inviteUrl(S.ledger.inviteToken); try { await navigator.clipboard.writeText(v); toast('Invite link copied'); } catch { $('#invite-url').select(); toast('Select the link and copy it'); } }),
  'new-invite': run(async () => {
    if (S.ledger.inviteToken && !await askConfirm('Make a new invite link?', 'The current link stops working. Anyone who has not joined yet will need the new one.', 'Make new link')) return;
    await mutate('POST', 'invite'); toast('New invite link ready');
  }),
  'stop-invite': run(async () => { await mutate('DELETE', 'invite'); toast('Invite link turned off'); }),
  'remove-member': run(async d => {
    const m = S.members.find(x=>x.userId===d.uid);
    if (!await askConfirm(`Remove ${esc(m.name)}?`, `@${esc(m.username)} will lose access to this ledger. Their past expenses stay, under the same name.`, 'Remove')) return;
    await mutate('DELETE', `members/${d.uid}`); toast(`${m.name} removed`);
  }),
  'leave-ledger': run(async () => {
    if (!await askConfirm(`Leave “${esc(S.ledger.name)}”?`, 'You will lose access to this ledger. Your past expenses stay, under the same name.', 'Leave')) return;
    await api('DELETE', `ledgers/${S.lid}/members/${S.user.id}`); await loadMe(); await openLedger(S.ledgers[0]?.id); toast('You left the ledger');
  }),
  'new-ledger': () => askText({title:'New ledger', label:'Ledger name', placeholder:'e.g. Flat 12', button:'Create',
    save: async name => { const r = await api('POST', 'ledgers', {name}); await loadMe(); await openLedger(r.id); toast('Ledger created'); }}),
  'rename-ledger': () => askText({title:'Rename ledger', label:'Ledger name', value:S.ledger.name,
    save: async name => { await api('PATCH', `ledgers/${S.lid}`, {name}); await loadMe(); await reload(); }}),
  'delete-ledger': run(async () => {
    if (!await askConfirm(`Delete “${esc(S.ledger.name)}” for everyone?`, 'All its groups, expenses, receipts and comments are deleted for every member. This cannot be undone.', 'Delete ledger')) return;
    await api('DELETE', `ledgers/${S.lid}`); await loadMe(); await openLedger(S.ledgers[0]?.id); toast('Ledger deleted');
  }),
};
document.addEventListener('click', e=>{
  const t = e.target.closest('[data-act]'); if (!t || t.disabled) return;
  const fn = ACT[t.dataset.act]; if (!fn) return;
  e.preventDefault(); fn(t.dataset, t, e);
});
document.addEventListener('change', run(async e=>{
  const t = e.target; const k = t.dataset?.change; if (!k) return;
  if (k==='me') return chooseMe(t.value);
  if (k==='ledger') return openLedger(t.value);
  if (k==='role') { await mutate('PATCH', `members/${t.dataset.uid}`, {role:t.value}); return toast('Access updated'); }
  if (k==='fgid') S.filt.gid = t.value;
  if (k==='fcat') S.filt.cat = t.value;
  if (k==='fpid') S.filt.pid = t.value;
  if (k==='ins-period') S.ins.period = t.value;
  if (k==='ins-gid') { S.ins.gid = t.value; S.ins.cur = null; }
  if (k==='ins-cur') S.ins.cur = t.value;
  render();
}));
let inputT;
document.addEventListener('input', e=>{
  const k = e.target.dataset?.input; if (!k) return;
  if (k==='q') S.filt.q = e.target.value;
  if (k==='gq') S.view.q = e.target.value;
  clearTimeout(inputT); inputT = setTimeout(render, 150);
});
document.addEventListener('submit', run(async e=>{
  const id = e.target.id;
  if (id==='budget-form') {
    e.preventDefault(); const v = $('#bud-amt').value.trim(); const c = v ? parseMoney(v) : 0;
    if (c==null || c<0) return toast('Enter a valid amount.');
    await mutate('PUT', 'prefs', {budget:c, budgetCur:$('#bud-cur').value}); toast(c ? 'Budget saved' : 'Budget removed');
  }
  if (id==='profile-form') {
    e.preventDefault(); await api('PATCH', 'me', {name:$('#pr-name').value}); await loadMe(); await reload(); toast('Name saved');
  }
  if (id==='person-name-form') {
    e.preventDefault(); await mutate('PATCH', `people/${meId()}`, {name:$('#pn-name').value}); toast('Saved');
  }
  if (id==='ledger-form') {
    e.preventDefault(); const name = $('#ledger-name').value.trim(); if (!name) return toast('Give the ledger a name.');
    const r = await api('POST', 'ledgers', {name}); await loadMe(); await openLedger(r.id);
  }
}));

start();
