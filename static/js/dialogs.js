// Modal dialogs: expense form, expense detail, settle up, group, person, and small prompts.
import {api} from './api.js';
import {$, CAT, CATS, CURS, FREQ, KINDS, METHODS, allocate, centsStr, dateTime, esc, evalExpr, fmt, guessCat, parseISO, parseMoney, toast, todayISO} from './util.js';
import {S, L, avatar, canWrite, groupList, meId, memberNet, mutate, nm, peopleList, render, verbS, whoFull} from './state.js';

const dlg = $('#dlg');
export function openDialog(html, mount){ dlg.innerHTML = html; if (!dlg.open) dlg.showModal(); mount?.(); }
export function closeDialog(){ if (dlg.open) dlg.close(); }
dlg.addEventListener('click', e=>{ if (e.target===dlg) closeDialog(); });
const head = (t) => `<header class="dlg-head"><h2>${t}</h2><button type="button" class="icon-btn" data-act="close-dlg" aria-label="Close">×</button></header>`;
const curOpts = sel => CURS.map(c=>`<option${c===sel?' selected':''}>${c}</option>`).join('');
const showErr = (id, m) => { const el = $(id); el.textContent = m; el.hidden = false; };

export function askConfirm(title, msg, label){
  return new Promise(res=>{
    openDialog(`<div class="dlg"><header class="dlg-head"><h2>${title}</h2></header><div class="dlg-scroll"><p style="margin:0">${msg}</p></div>
      <footer class="dlg-foot"><span class="sp"><button class="btn ghost" id="cf-no">Cancel</button><button class="btn primary" id="cf-yes">${label}</button></span></footer></div>`);
    $('#cf-no').onclick = ()=>{ closeDialog(); res(false); };
    $('#cf-yes').onclick = ()=>{ closeDialog(); res(true); };
    dlg.addEventListener('close', ()=>res(false), {once:true});
  });
}

// One-field form. `save` receives the trimmed value and may throw to show an error.
export function askText({title, label, value='', placeholder='', maxlength=60, button='Save', save}){
  openDialog(`<form class="dlg" id="tf" novalidate>${head(title)}<div class="dlg-scroll">
    <label class="fld">${label}<input id="tf-in" maxlength="${maxlength}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off"></label>
    <p class="err-t" id="tf-err" hidden></p></div>
    <footer class="dlg-foot"><span class="sp"><button type="button" class="btn ghost" data-act="close-dlg">Cancel</button><button class="btn primary" type="submit">${button}</button></span></footer></form>`, ()=>{
    $('#tf-in').focus();
    $('#tf').addEventListener('submit', async ev=>{
      ev.preventDefault();
      const v = $('#tf-in').value.trim(); if (!v) return showErr('#tf-err', `${label} is required.`);
      try { await save(v); closeDialog(); } catch (e) { showErr('#tf-err', e.message); }
    });
  });
}

export function openPassword(){
  openDialog(`<form class="dlg" id="pwf" novalidate>${head('Change password')}<div class="dlg-scroll">
    <label class="fld">Current password<input id="pw-cur" type="password" autocomplete="current-password" maxlength="200"></label>
    <label class="fld">New password<input id="pw-new" type="password" autocomplete="new-password" minlength="8" maxlength="200"></label>
    <p class="mut" style="margin:0;font-size:13px">At least 8 characters. Your other devices will be signed out.</p>
    <p class="err-t" id="pw-err" hidden></p></div>
    <footer class="dlg-foot"><span class="sp"><button type="button" class="btn ghost" data-act="close-dlg">Cancel</button><button class="btn primary" type="submit">Change password</button></span></footer></form>`, ()=>{
    $('#pw-cur').focus();
    $('#pwf').addEventListener('submit', async ev=>{
      ev.preventDefault();
      try { await api('POST', 'auth/password', {current:$('#pw-cur').value, new:$('#pw-new').value}); closeDialog(); toast('Password changed'); }
      catch (e) { showErr('#pw-err', e.message); }
    });
  });
}

/* ---------- expense form ---------- */
let F = null;
function poolFor(gid){
  if (gid && S.groups[gid]) return S.groups[gid].memberIds.filter(id=>S.people[id] && !S.people[id].deleted);
  return peopleList().map(p=>p.id);
}
export function openExpense(id, pre={}){
  const e = id ? S.expenses[id] : null;
  if (e?.type==='payment') return openSettle({editId:id});
  const gid = e ? (e.groupId||'') : (pre.gid ?? (S.view.name==='group' ? S.view.id : ''));
  const g = S.groups[gid]; const pool = poolFor(gid); const me = meId();
  const toStr = m => Object.fromEntries(Object.entries(m||{}).map(([k,v])=>[k,centsStr(v)]));
  if (e) F = {id, desc:e.desc, cat:e.category||'other', amount:centsStr(e.amount), cur:e.currency, date:e.date, gid, notes:e.notes||'', repeat:'none', receiptId:e.receiptId||null, file:null,
    payer: Object.keys(e.paid).length===1 ? Object.keys(e.paid)[0] : 'multi', paidVals:toStr(e.paid), method:e.split?.method||'exact',
    sel:new Set(Object.keys(e.owed)), vals: e.split?.vals && Object.keys(e.split.vals).length ? {...e.split.vals} : toStr(e.owed), catTouched:true};
  else {
    const withF = S.view.name==='friend' ? S.view.id : null;
    F = {id:null, desc:'', cat:'other', amount:'', cur:g?.currency || S.prefs.currency || 'MDL', date:todayISO(), gid, notes:'', repeat:'none', receiptId:null, file:null,
      payer: pool.includes(me) ? me : (pool[0]||''), paidVals:{}, method:'equal', sel:new Set(withF && me ? [me, withF] : pool), vals:{}, catTouched:false};
  }
  openDialog(`<form class="dlg" id="xf" novalidate>${head(id?'Edit expense':'Add an expense')}<div class="dlg-scroll">
    <div class="row2"><label class="fld grow">Description<input id="f-desc" maxlength="80" placeholder="e.g. Dinner at the lake" value="${esc(F.desc)}" autocomplete="off"></label>
      <label class="fld">Category<select id="f-cat">${CATS.map(c=>`<option value="${c.k}"${c.k===F.cat?' selected':''}>${c.l}</option>`).join('')}</select></label></div>
    <div class="row2"><label class="fld grow">Amount<input id="f-amt" inputmode="decimal" placeholder="0.00, or a sum like 120+35.5" value="${esc(F.amount)}" autocomplete="off"></label>
      <label class="fld">Currency<select id="f-cur">${curOpts(F.cur)}</select></label>
      <label class="fld">Date<input id="f-date" type="date" value="${F.date}"></label></div>
    <label class="fld">Group<select id="f-group">${groupList().map(g=>`<option value="${g.id}"${g.id===gid?' selected':''}>${esc(g.name)}</option>`).join('')}<option value=""${gid===''?' selected':''}>No group (between friends)</option></select></label>
    <div id="f-dyn" style="display:flex;flex-direction:column;gap:14px"></div>
    <div id="f-sum" class="sum" aria-live="polite"></div>
    <details class="more"${F.notes||F.receiptId?' open':''}><summary>Notes, receipt, repeat</summary><div class="morein">
      <label class="fld">Notes<textarea id="f-notes" maxlength="500" placeholder="Anything worth remembering">${esc(F.notes)}</textarea></label>
      <label class="fld">Receipt photo or PDF${F.receiptId?` <span class="mut">(one attached; choosing a new file replaces it)</span>`:''}<input id="f-file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf"></label>
      ${!id ? `<label class="fld">Repeat<select id="f-repeat">${Object.entries(FREQ).map(([k,l])=>`<option value="${k}">${l}</option>`).join('')}</select></label>` : ''}
    </div></details>
    <p class="err-t" id="f-err" hidden></p></div>
    <footer class="dlg-foot"><span class="sp"><button type="button" class="btn ghost" data-act="close-dlg">Cancel</button><button class="btn primary" type="submit" id="f-save">Save</button></span></footer></form>`, ()=>{
      renderDyn(); updateSum();
      const form = $('#xf');
      form.addEventListener('input', onFormInput);
      form.addEventListener('change', onFormChange);
      form.addEventListener('submit', saveExpense);
      if (!id) $('#f-desc').focus();
    });
}
function renderDyn(){
  const pool = poolFor(F.gid);
  const names = pool.map(id=>[id, nm(id,true)]);
  if (!pool.length) { $('#f-dyn').innerHTML = `<div class="note warn"><p>This group has no members. Edit the group to add people first.</p></div>`; return; }
  if (F.payer!=='multi' && !pool.includes(F.payer)) F.payer = pool.includes(meId()) ? meId() : pool[0];
  const unit = (F.method==='percent') ? '%' : (F.method==='shares') ? '×' : (F.method==='adjust') ? '±' : '';
  $('#f-dyn').innerHTML = `
    <label class="fld">Paid by<select id="f-payer">${names.map(([id,n])=>`<option value="${id}"${F.payer===id?' selected':''}>${esc(n)}</option>`).join('')}<option value="multi"${F.payer==='multi'?' selected':''}>Several people…</option></select></label>
    ${F.payer==='multi' ? `<div class="parts" aria-label="How much each person paid">${names.map(([id,n])=>`<div class="part"><label for="pv-${id}">${avatar(id,true)}<span>${esc(n)}</span></label><input type="text" inputmode="decimal" id="pv-${id}" data-pv="${id}" value="${esc(F.paidVals[id]||'')}" placeholder="0.00"></div>`).join('')}</div>` : ''}
    <div class="sub-h"><span>Split</span>${F.method==='equal'||F.method==='adjust'?`<span><button type="button" class="link" data-act="f-all">All</button> · <button type="button" class="link" data-act="f-none">None</button></span>`:''}</div>
    <div class="seg" role="group" aria-label="Split method">${METHODS.map(([k,l])=>`<button type="button" class="${F.method===k?'on':''}" data-act="f-method" data-m="${k}">${l}</button>`).join('')}</div>
    <div class="parts">${names.map(([id,n])=>{
      const box = (F.method==='equal'||F.method==='adjust');
      return `<div class="part"><label for="${box?'sel-'+id:'v-'+id}">${box?`<input type="checkbox" id="sel-${id}" data-sel="${id}"${F.sel.has(id)?' checked':''}>`:''}${avatar(id,true)}<span>${esc(n)}</span></label>
        ${F.method!=='equal' ? `<span class="unit">${unit}</span><input type="text" inputmode="decimal" id="v-${id}" data-v="${id}" value="${esc(F.vals[id]||'')}" placeholder="${F.method==='shares'?'1':'0'}">` : ''}
        <span class="share" id="sh-${id}"></span></div>`; }).join('')}</div>
    <p class="mut" style="margin:0;font-size:13px">${{equal:'Everyone ticked pays the same.',exact:'Type how much each person owes. Leave blank for people not involved.',percent:'Percentages must add up to 100.',shares:'For example, 2 shares for a couple and 1 for a single person.',adjust:'Add or subtract an amount for someone, for example +20 for a starter only they had. The rest is split equally.'}[F.method]}</p>`;
}
function splitIds(pool){
  if (F.method==='equal'||F.method==='adjust') return pool.filter(id=>F.sel.has(id));
  if (F.method==='exact') return pool.filter(id=>(parseMoney(F.vals[id]||'')||0)!==0);
  return pool.filter(id=>(evalExpr(F.vals[id]||'')||0)>0);
}
function computeSplit(total){
  const ids = splitIds(poolFor(F.gid));
  if (!ids.length) return {error:'Choose who this expense is split between.'};
  if (F.method==='equal') return {owed: allocate(total, ids.map(id=>[id,1]))};
  if (F.method==='exact') {
    const owed = {}; let s = 0;
    for (const id of ids) { const c = parseMoney(F.vals[id]); if (c==null || c<0) return {error:`Check the amount for ${nm(id)}.`}; owed[id] = c; s += c; }
    if (s!==total) return {owed, error: s<total ? `${fmt(total-s,F.cur)} is not assigned to anyone yet.` : `The amounts are ${fmt(s-total,F.cur)} more than the total.`};
    return {owed};
  }
  if (F.method==='percent') {
    const s = ids.reduce((a,id)=>a+evalExpr(F.vals[id]),0);
    if (Math.abs(s-100)>0.001) return {error:`Percentages add up to ${+s.toFixed(2)}%. They need to add up to 100%.`};
    return {owed: allocate(total, ids.map(id=>[id, evalExpr(F.vals[id])]))};
  }
  if (F.method==='shares') return {owed: allocate(total, ids.map(id=>[id, evalExpr(F.vals[id])]))};
  if (F.method==='adjust') {
    const adj = {}; let s = 0;
    for (const id of ids) { const c = parseMoney(F.vals[id]||'0') ?? null; if (c==null) return {error:`Check the adjustment for ${nm(id)}.`}; adj[id] = c; s += c; }
    if (s>total) return {error:'The adjustments are more than the total.'};
    const base = allocate(total-s, ids.map(id=>[id,1]));
    const owed = {}; for (const id of ids) { owed[id] = base[id]+adj[id]; if (owed[id]<0) return {error:`${nm(id,true)} would end up with a negative share.`}; }
    return {owed};
  }
}
function computePaid(total){
  if (F.payer!=='multi') return {paid:{[F.payer]:total}};
  const paid = {}; let s = 0;
  for (const id of poolFor(F.gid)) { const v = F.paidVals[id]; if (!v) continue; const c = parseMoney(v); if (c==null||c<0) return {error:`Check what ${nm(id)} paid.`}; if (c) { paid[id] = c; s += c; } }
  if (!s) return {error:'Enter how much each person paid.'};
  if (s!==total) return {paid, error:`The payers add up to ${fmt(s,F.cur)}, but the total is ${fmt(total,F.cur)}.`};
  return {paid};
}
function updateSum(){
  const total = parseMoney(F.amount);
  const sum = $('#f-sum'); if (!sum) return;
  for (const id of poolFor(F.gid)) { const el = $('#sh-'+id); if (el) el.textContent = ''; }
  if (!total || total<=0) { sum.className = 'sum'; sum.textContent = F.amount.trim() ? 'Enter an amount above zero.' : 'Enter the amount to see each person’s share.'; return; }
  const sp = computeSplit(total); const pd = computePaid(total);
  if (sp.owed) for (const [id,c] of Object.entries(sp.owed)) { const el = $('#sh-'+id); if (el) el.textContent = fmt(c, F.cur); }
  const err = pd.error || sp.error;
  sum.className = 'sum ' + (err ? 'err' : 'ok');
  if (err) { sum.textContent = err; return; }
  const n = Object.keys(sp.owed).length;
  const exprNote = /[+\-*/]/.test(F.amount.replace(/^-/,'')) ? `${fmt(total,F.cur)} in total. ` : '';
  sum.textContent = `${exprNote}Split between ${n} ${n===1?'person':'people'}${F.method==='equal'&&n>1?`, ${fmt(Math.floor(total/n),F.cur)} each`:''}.`;
}
function onFormInput(e){
  const t = e.target;
  if (t.id==='f-desc') { F.desc = t.value; if (!F.catTouched) { const g = guessCat(t.value); if (g) { F.cat = g; $('#f-cat').value = g; } } return; }
  if (t.id==='f-amt') F.amount = t.value;
  if (t.id==='f-notes') F.notes = t.value;
  if (t.dataset.v) F.vals[t.dataset.v] = t.value;
  if (t.dataset.pv) F.paidVals[t.dataset.pv] = t.value;
  updateSum();
}
function onFormChange(e){
  const t = e.target;
  if (t.id==='f-cat') { F.cat = t.value; F.catTouched = true; }
  if (t.id==='f-cur') { F.cur = t.value; updateSum(); }
  if (t.id==='f-date') F.date = t.value;
  if (t.id==='f-repeat') F.repeat = t.value;
  if (t.id==='f-file') F.file = t.files[0] || null;
  if (t.id==='f-group') { F.gid = t.value; const g = S.groups[F.gid]; if (g && !F.id) { F.cur = g.currency; $('#f-cur').value = g.currency; } F.sel = new Set(poolFor(F.gid)); renderDyn(); updateSum(); }
  if (t.id==='f-payer') { F.payer = t.value; renderDyn(); updateSum(); }
  if (t.dataset.sel) { t.checked ? F.sel.add(t.dataset.sel) : F.sel.delete(t.dataset.sel); updateSum(); }
}
// Handlers for the split controls inside the form (wired from main.js's click dispatcher).
export const formActions = {
  'f-method': d => {
    F.method = d.m;
    // start each method from an even split of the people currently ticked
    const ids = poolFor(F.gid).filter(id=>F.sel.has(id)); const n = ids.length || 1; const total = parseMoney(F.amount) || 0;
    F.vals = {};
    if (d.m==='shares') ids.forEach(id=>F.vals[id] = '1');
    if (d.m==='percent') { const base = Math.floor(10000/n)/100; ids.forEach((id,i)=>F.vals[id] = String(i===n-1 ? +(100-base*(n-1)).toFixed(2) : base)); }
    if (d.m==='exact' && total) { const al = allocate(total, ids.map(id=>[id,1])); ids.forEach(id=>F.vals[id] = centsStr(al[id])); }
    renderDyn(); updateSum();
  },
  'f-all': () => { F.sel = new Set(poolFor(F.gid)); renderDyn(); updateSum(); },
  'f-none': () => { F.sel = new Set(); renderDyn(); updateSum(); },
};
async function saveExpense(ev){
  ev.preventDefault();
  const err = m => showErr('#f-err', m);
  const total = parseMoney(F.amount);
  if (!F.desc.trim()) return err('Add a short description, such as “Groceries”.');
  if (!total || total<=0) return err('Enter an amount above zero.');
  if (!F.date) return err('Pick a date.');
  const pd = computePaid(total); if (pd.error) return err(pd.error);
  const sp = computeSplit(total); if (sp.error) return err(sp.error);
  const btn = $('#f-save'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    let receiptId = F.receiptId;
    if (F.file) receiptId = (await api('POST', L('receipts'), F.file, {raw:true, contentType:F.file.type||'application/octet-stream'})).id;
    const owed = Object.fromEntries(Object.entries(sp.owed).filter(([,v])=>v>0));
    const keepVals = F.method==='equal' ? {} : Object.fromEntries(splitIds(poolFor(F.gid)).map(id=>[id, String(F.vals[id]||'')]));
    const body = {type:'expense', groupId:F.gid, desc:F.desc.trim(), category:F.cat, currency:F.cur, amount:total, date:F.date, paid:pd.paid, owed,
      split:{method:F.method, vals:keepVals}, notes:F.notes.trim(), receiptId:receiptId||null};
    if (F.id) { await mutate('PUT', `expenses/${F.id}`, body); toast('Expense updated'); }
    else {
      await mutate('POST', 'expenses', {...body, repeat:F.repeat});
      if (S.prefs.currency!==F.cur) api('PUT', L('prefs'), {currency:F.cur}).then(()=>{ S.prefs.currency = F.cur; }).catch(()=>{});
      toast(F.repeat!=='none' ? `Expense added. It repeats ${F.repeat==='weekly'?'every week':F.repeat==='monthly'?'every month':'every year'}.` : 'Expense added');
    }
    closeDialog();
  } catch (e) { btn.disabled = false; btn.textContent = 'Save'; err(e.message); }
}

/* ---------- expense detail ---------- */
export const receiptUrl = rid => 'api/' + L('receipts/' + encodeURIComponent(rid));
export function openDetail(id){
  const e = S.expenses[id]; if (!e) return;
  const cat = CAT[e.category]||CAT.other;
  const gname = e.groupId ? S.groups[e.groupId]?.name : 'No group';
  const isPay = e.type==='payment';
  const lines = isPay ? `<div><span>${esc(nm(Object.keys(e.paid)[0],true))} paid ${esc(nm(Object.keys(e.owed)[0]))}</span><b class="num">${fmt(e.amount,e.currency)}</b></div>`
    : Object.entries(e.paid).map(([p,v])=>`<div><span>${esc(nm(p,true))} paid</span><b class="num">${fmt(v,e.currency)}</b></div>`).join('') + '<hr style="border:0;border-top:1px solid var(--line);margin:4px 0;width:100%">' +
      Object.entries(e.owed).sort((a,b)=>b[1]-a[1]).map(([p,v])=>`<div><span>${esc(nm(p,true))} ${verbS(p,'owe','owes')}${(e.paid||{})[p]?' (already paid part)':''}</span><span class="num">${fmt(v,e.currency)}</span></div>`).join('');
  const method = METHODS.find(m=>m[0]===e.split?.method)?.[1] || '';
  const rUrl = e.receiptId ? receiptUrl(e.receiptId) : '';
  const receipt = !e.receiptId ? '' : S.receipts[e.receiptId]==='application/pdf'
    ? `<div><a class="btn" href="${esc(rUrl)}" download>Download PDF receipt</a></div>`
    : `<div><a href="${esc(rUrl)}" target="_blank" rel="noopener noreferrer"><img class="receipt" src="${esc(rUrl)}" alt="Receipt for ${esc(e.desc||'payment')}"></a></div>`;
  openDialog(`<div class="dlg">${head(isPay?'Payment':esc(e.desc))}<div class="dlg-scroll">
    <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap"><span class="sw" style="width:16px;height:16px;background:${isPay?'var(--pos)':cat.c}"></span><span class="big">${fmt(e.amount,e.currency)}</span></div>
    <dl class="kv"><dt>Date</dt><dd>${parseISO(e.date).toLocaleDateString(undefined,{dateStyle:'full'})}</dd><dt>Group</dt><dd>${esc(gname||'')}</dd>${isPay?'':`<dt>Category</dt><dd>${cat.l}</dd><dt>Split</dt><dd>${method}</dd>`}
      <dt>Added</dt><dd>${esc(whoFull(e.createdBy))}${e.createdAt?', '+dateTime(e.createdAt):''}${e.auto?' (repeating)':''}</dd>
      ${e.updatedAt && e.updatedAt-(e.createdAt||0)>2000 ? `<dt>Edited</dt><dd>${esc(whoFull(e.updatedBy))}, ${dateTime(e.updatedAt)}</dd>`:''}</dl>
    <div class="det-lines">${lines}</div>
    ${e.notes?`<div class="cmt"><small>Notes</small>${esc(e.notes)}</div>`:''}
    ${receipt}
    <div class="sub-h">Comments</div>
    <div style="display:flex;flex-direction:column;gap:8px" id="cmts">${(e.comments||[]).map(c=>`<div class="cmt"><small>${esc(whoFull(c.by))} · ${dateTime(c.at)}</small>${esc(c.text)}</div>`).join('') || '<span class="mut" style="font-size:14px">No comments yet.</span>'}</div>
    ${canWrite()?`<form class="inline" id="cmt-form"><input id="cmt-in" maxlength="300" placeholder="Add a comment" aria-label="Add a comment"><button class="btn" type="submit">Post</button></form>`:''}
    </div><footer class="dlg-foot">${canWrite()?`<button class="btn danger" data-act="del-expense" data-id="${id}">Delete</button><span class="sp"><button class="btn primary" data-act="edit-expense" data-id="${id}">Edit</button></span>`:'<span class="sp"><button class="btn" data-act="close-dlg">Close</button></span>'}</footer></div>`, ()=>{
      const f = $('#cmt-form'); if (f) f.addEventListener('submit', async ev=>{ ev.preventDefault(); const text = $('#cmt-in').value.trim(); if (!text) return;
        try { await mutate('POST', `expenses/${id}/comments`, {text}); openDetail(id); } catch (er) { toast(er.message); } });
    });
}

/* ---------- settle up ---------- */
export function openSettle(pre={}){
  const ex = pre.editId ? S.expenses[pre.editId] : null;
  const me = meId(); const people = peopleList();
  let gid = ex ? (ex.groupId||'') : (pre.gid ?? (S.view.name==='group' ? S.view.id : ''));
  let from = ex ? Object.keys(ex.paid)[0] : pre.from, to = ex ? Object.keys(ex.owed)[0] : pre.to;
  if (!from && !to) { // suggest the first debt involving me
    const e1 = S.calc.edges.find(x=>(gid==='' || x.gid===gid) && (x.from===me||x.to===me)) || S.calc.edges.find(x=>x.gid===gid);
    if (e1) { from = e1.from; to = e1.to; pre.amt = e1.amt; pre.cur = e1.cur; }
  }
  // Settling from the dashboard or a friend page: if the whole debt sits in one group, record it there
  // so that group's balance actually clears.
  if (!ex && pre.gid==null && S.view.name!=='group' && from && to) {
    const gs = [...new Set(S.calc.edges.filter(x=>x.from===from && x.to===to).map(x=>x.gid))];
    if (gs.length===1) gid = gs[0];
  }
  from ||= me || people[0]?.id; to ||= people.find(p=>p.id!==from)?.id;
  const amt = ex ? centsStr(ex.amount) : pre.amt ? centsStr(+pre.amt) : '';
  const cur = ex ? ex.currency : pre.cur || S.groups[gid]?.currency || S.prefs.currency || 'MDL';
  const opts = sel => people.map(p=>`<option value="${p.id}"${p.id===sel?' selected':''}>${esc(nm(p.id,true))}</option>`).join('');
  openDialog(`<form class="dlg" id="sf" novalidate>${head(ex?'Edit payment':'Record a payment')}<div class="dlg-scroll">
    <div class="row2"><label class="fld">Who paid<select id="s-from">${opts(from)}</select></label><label class="fld">Paid to<select id="s-to">${opts(to)}</select></label></div>
    <div class="row2"><label class="fld grow">Amount<input id="s-amt" inputmode="decimal" value="${amt}" placeholder="0.00"></label><label class="fld">Currency<select id="s-cur">${curOpts(cur)}</select></label><label class="fld">Date<input type="date" id="s-date" value="${ex?ex.date:todayISO()}"></label></div>
    <label class="fld">Group<select id="s-group">${groupList().map(g=>`<option value="${g.id}"${g.id===gid?' selected':''}>${esc(g.name)}</option>`).join('')}<option value=""${gid===''?' selected':''}>No group</option></select></label>
    <label class="fld">Note<input id="s-notes" maxlength="120" placeholder="e.g. Cash, bank transfer, MIA" value="${esc(ex?.notes||'')}"></label>
    <p class="mut" style="margin:0;font-size:13px">This records money that changed hands outside the app. Evenly does not send money.</p>
    <p class="err-t" id="s-err" hidden></p></div>
    <footer class="dlg-foot">${ex?`<button type="button" class="btn danger" data-act="del-expense" data-id="${pre.editId}">Delete</button>`:''}<span class="sp"><button type="button" class="btn ghost" data-act="close-dlg">Cancel</button><button class="btn primary" type="submit">Save payment</button></span></footer></form>`, ()=>{
      $('#sf').addEventListener('submit', async ev=>{
        ev.preventDefault();
        const err = m => showErr('#s-err', m);
        const f = $('#s-from').value, t = $('#s-to').value, a = parseMoney($('#s-amt').value);
        if (!f || !t || f===t) return err('Choose two different people.');
        if (!a || a<=0) return err('Enter an amount above zero.');
        const body = {type:'payment', groupId:$('#s-group').value, desc:'Payment', category:'other', currency:$('#s-cur').value, amount:a,
          date:$('#s-date').value||todayISO(), paid:{[f]:a}, owed:{[t]:a}, notes:$('#s-notes').value.trim()};
        try {
          if (ex) await mutate('PUT', `expenses/${pre.editId}`, body);
          else await mutate('POST', 'expenses', body);
          closeDialog(); toast(ex ? 'Payment updated' : `Recorded: ${nm(f,true)} paid ${nm(t)} ${fmt(a, body.currency)}`);
        } catch (e) { err(e.message); }
      });
    });
}

/* ---------- group form ---------- */
export function openGroup(id){
  const g = id ? S.groups[id] : null; const me = meId();
  const sel = new Set(g ? g.memberIds : (me ? [me] : []));
  openDialog(`<form class="dlg" id="gf" novalidate>${head(id?'Edit group':'New group')}<div class="dlg-scroll">
    <div class="row2"><label class="fld grow">Name<input id="g-name" maxlength="50" placeholder="e.g. Flat on Ștefan cel Mare" value="${esc(g?.name||'')}"></label>
      <label class="fld">Type<select id="g-kind">${KINDS.map(k=>`<option${k===(g?.kind||'Trip')?' selected':''}>${k}</option>`).join('')}</select></label>
      <label class="fld">Currency<select id="g-cur">${curOpts(g?.currency || S.prefs.currency || 'MDL')}</select></label></div>
    <div class="fld">Members<div class="chk" id="g-mem">${peopleList().map(p=>`<label><input type="checkbox" value="${p.id}"${sel.has(p.id)?' checked':''}>${avatar(p.id,true)}${esc(nm(p.id,true))}</label>`).join('') || '<span class="mut">No people yet. Add them below.</span>'}</div></div>
    <label class="fld">Add new people<input id="g-new" placeholder="Names separated by commas, e.g. Ana, Ion, Maria" maxlength="300"></label>
    <p class="mut" style="margin:0;font-size:13px">People you add here do not need an account. If they join later from your invite link, they pick their own name and it becomes linked to them.</p>
    <label style="display:flex;gap:10px;align-items:flex-start;font-size:14px"><input type="checkbox" id="g-simp"${g?.simplify===false?'':' checked'} style="margin-top:4px"><span><b>Simplify debts</b><br><span class="mut">Combine debts so the group needs fewer payments. For example, if Ana owes Ion and Ion owes Maria, Ana pays Maria directly.</span></span></label>
    <p class="err-t" id="g-err" hidden></p></div>
    <footer class="dlg-foot"><span class="sp"><button type="button" class="btn ghost" data-act="close-dlg">Cancel</button><button class="btn primary" type="submit">${id?'Save':'Create group'}</button></span></footer></form>`, ()=>{
      if (!id) $('#g-name').focus();
      $('#gf').addEventListener('submit', async ev=>{
        ev.preventDefault();
        const err = m => showErr('#g-err', m);
        const name = $('#g-name').value.trim(); if (!name) return err('Give the group a name.');
        const members = [...$('#g-mem').querySelectorAll('input:checked')].map(i=>i.value);
        const newNames = $('#g-new').value.split(',').map(s=>s.trim()).filter(Boolean);
        if (!members.length && !newNames.length) return err('Add at least one member.');
        if (id) {
          const net = memberNet(id);
          const stuck = g.memberIds.filter(x=>!members.includes(x)).filter(x=>Object.values(net).some(m=>m[x]));
          if (stuck.length) return err(`${stuck.map(x=>nm(x,true)).join(', ')} still ${stuck.length>1?'have':'has'} a balance in this group. Settle up before removing them.`);
        }
        const body = {name, kind:$('#g-kind').value, currency:$('#g-cur').value, memberIds:members, newNames, simplify:$('#g-simp').checked};
        try {
          if (id) { await mutate('PUT', `groups/${id}`, body); toast('Group saved'); }
          else { const r = await mutate('POST', 'groups', body); S.view = {name:'group', id:r.id, tab:'expenses'}; render(); toast('Group created'); }
          closeDialog();
        } catch (e) { err(e.message); }
      });
    });
}

/* ---------- person form ---------- */
export function openPerson(id){
  const p = id ? S.people[id] : null;
  openDialog(`<form class="dlg" id="pf" novalidate>${head(id?'Edit friend':'Add a friend')}<div class="dlg-scroll">
    <label class="fld">Name<input id="p-name" maxlength="40" value="${esc(p?.name||'')}" placeholder="e.g. Maria"></label>
    ${!id && groupList().length ? `<div class="fld">Also add to groups<div class="chk" id="p-groups">${groupList().map(g=>`<label><input type="checkbox" value="${g.id}"${S.view.name==='group'&&S.view.id===g.id?' checked':''}>${esc(g.name)}</label>`).join('')}</div></div>` : ''}
    <p class="mut" style="margin:0;font-size:13px">Friends do not need an account to be part of expenses. To let them see the balances too, send them the invite link from Settings.</p>
    <p class="err-t" id="p-err" hidden></p></div>
    <footer class="dlg-foot"><span class="sp"><button type="button" class="btn ghost" data-act="close-dlg">Cancel</button><button class="btn primary" type="submit">${id?'Save':'Add friend'}</button></span></footer></form>`, ()=>{
      $('#p-name').focus();
      $('#pf').addEventListener('submit', async ev=>{
        ev.preventDefault();
        const name = $('#p-name').value.trim();
        if (!name) return showErr('#p-err', 'Enter a name.');
        try {
          if (id) await mutate('PATCH', `people/${id}`, {name});
          else await mutate('POST', 'people', {name, groupIds:[...document.querySelectorAll('#p-groups input:checked')].map(i=>i.value)});
          closeDialog(); toast(id ? 'Saved' : `${name} added`);
        } catch (e) { showErr('#p-err', e.message); }
      });
    });
}
