// Pure helpers: constants, formatting, money parsing. No app state in here.

export const CATS = [
  {k:'food',l:'Food & drink',c:'#D9822B',kw:['dinner','lunch','breakfast','restaurant','cafe','café','coffee','pizza','bar ','beer','food','sushi','burger','brunch','takeaway','glovo','straus']},
  {k:'groceries',l:'Groceries',c:'#5E9E3F',kw:['grocer','supermarket','linella','kaufland','lidl','market','nr1','fourchette','carrefour','auchan','food shop']},
  {k:'rent',l:'Rent',c:'#7A5CC4',kw:['rent','chirie','apartment','lease','mortgage']},
  {k:'utilities',l:'Utilities',c:'#2F8FB0',kw:['electric','gas bill','water','internet','phone','utilit','heating','wifi','moldtelecom','orange','starnet']},
  {k:'transport',l:'Transport',c:'#3C6FD1',kw:['taxi','uber','yandex','bolt','bus','train','fuel','petrol','benzin','parking','metro','car ']},
  {k:'travel',l:'Travel & stay',c:'#C2447A',kw:['hotel','flight','airbnb','hostel','booking','trip','wizz','ryanair','visa']},
  {k:'fun',l:'Entertainment',c:'#9C55B5',kw:['movie','cinema','concert','game','netflix','spotify','club','party','bowling','karaoke','tickets']},
  {k:'shopping',l:'Shopping',c:'#A57A2C',kw:['clothes','amazon','shop','ikea','temu','shoes','emag']},
  {k:'health',l:'Health',c:'#2E9E8F',kw:['pharmacy','farmacia','doctor','medicine','gym','dentist','clinic']},
  {k:'gifts',l:'Gifts',c:'#D0544B',kw:['gift','birthday','present','flowers','cadou']},
  {k:'household',l:'Household',c:'#6F8B3A',kw:['cleaning','detergent','furniture','repair','kitchen','toilet paper']},
  {k:'other',l:'Other',c:'#7B8682',kw:[]},
];
export const CAT = Object.fromEntries(CATS.map(c=>[c.k,c]));
export const CURS = ['MDL','EUR','USD','RON','GBP','UAH','PLN','CHF','TRY','CZK','HUF','BGN'];
export const KINDS = ['Trip','Home','Couple','Friends','Work','Other'];
export const METHODS = [['equal','Equally'],['exact','Exact amounts'],['percent','Percent'],['shares','Shares'],['adjust','Adjust']];
export const FREQ = {none:'Does not repeat',weekly:'Every week',monthly:'Every month',yearly:'Every year'};
export const ROLES = {owner:'Owner', editor:'Can edit', viewer:'Can view'};
export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export const $ = (s,r=document)=>r.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2,'0');
export const iso = d => d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
export const todayISO = () => iso(new Date());
export const parseISO = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };

const fmtCache = {};
export function fmt(c, cur){
  try { const f = fmtCache[cur] ??= new Intl.NumberFormat(undefined,{style:'currency',currency:cur}); return f.format(c/100); }
  catch { return (c/100).toFixed(2)+' '+cur; }
}
export function fmtShort(c, cur){
  try { return new Intl.NumberFormat(undefined,{style:'currency',currency:cur,notation:'compact',maximumFractionDigits:1}).format(c/100); }
  catch { return Math.round(c/100)+' '+cur; }
}
// Accepts "12.50", "12,50" or a small sum like "120+35.5" (no eval: a tiny recursive-descent parser).
export function evalExpr(src){
  const s = String(src).replace(/,/g,'.').replace(/\s/g,'');
  if (!s || !/^[\d.+\-*/()]+$/.test(s)) return null;
  let i = 0;
  const num = () => {
    if (s[i]==='(') { i++; const v = add(); if (s[i++]!==')') throw 0; return v; }
    if (s[i]==='-') { i++; return -num(); }
    const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i)); if (!m) throw 0; i += m[0].length; return parseFloat(m[0]);
  };
  const mul = () => { let v = num(); while (s[i]==='*'||s[i]==='/') { const o = s[i++]; const r = num(); v = o==='*' ? v*r : v/r; } return v; };
  const add = () => { let v = mul(); while (s[i]==='+'||s[i]==='-') { const o = s[i++]; const r = mul(); v = o==='+' ? v+r : v-r; } return v; };
  try { const v = add(); return (i===s.length && isFinite(v)) ? v : null; } catch { return null; }
}
export const parseMoney = s => { const v = evalExpr(s); return v==null ? null : Math.round(v*100); };
export const centsStr = c => (c/100).toFixed(2);
// Split `total` cents by weights; leftover cents go to the largest remainders, so the parts always sum to total.
export function allocate(total, weights){
  const sum = weights.reduce((a,[,w])=>a+w,0); if (sum<=0) return null;
  const out = {}, rems = []; let used = 0;
  for (const [id,w] of weights) { const ex = total*w/sum; const f = Math.floor(ex); out[id] = f; used += f; rems.push([id, ex-f]); }
  rems.sort((a,b)=>b[1]-a[1]);
  for (let k=0, left=total-used; left>0; k++, left--) out[rems[k%rems.length][0]]++;
  return out;
}
export function guessCat(desc){
  const d = ' '+desc.toLowerCase()+' ';
  for (const c of CATS) if (c.kw.some(k=>d.includes(k))) return c.k;
  return null;
}
export function hueOf(id){ let h = 0; for (const ch of String(id)) h = (h*31 + ch.charCodeAt(0)) >>> 0; return h % 360; }
export function initials(n){ const p = String(n||'?').trim().split(/\s+/); return ((p[0]?.[0]||'?') + (p[1]?.[0]||'')).toUpperCase(); }
export function advance(dateISO, freq, anchor){
  const d = parseISO(dateISO);
  if (freq==='weekly') { d.setDate(d.getDate()+7); return iso(d); }
  const y = d.getFullYear() + (freq==='yearly'?1:0), m = d.getMonth() + (freq==='monthly'?1:0);
  const last = new Date(y, m+1, 0).getDate();
  return iso(new Date(y, m, Math.min(anchor||d.getDate(), last)));
}
export const dateTime = t => new Date(t).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});

let toastT;
export function toast(msg){ const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(()=>t.classList.remove('show'), 2600); }
