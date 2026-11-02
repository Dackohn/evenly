// Sign-in and account creation screen. Shown instead of the app until there is a session.
import {api} from './api.js';
import {$, esc} from './util.js';
import {BRAND} from './views.js';

// invite: {token, ledgerName} when the page was opened from an invite link
export async function showAuth(invite, onDone){
  let cfg = {openSignup:false, firstUser:false};
  try { cfg = await api('GET', 'config'); } catch {}
  const canSignup = cfg.openSignup || !!invite;
  let mode = invite || cfg.firstUser ? 'register' : 'login';
  $('#app').hidden = true;
  const box = $('#auth'); box.hidden = false;

  const draw = () => {
    box.innerHTML = `<div class="auth-card card">
      <div class="brand" style="padding:0">${BRAND}</div>
      ${invite ? `<div class="note info"><p>You were invited to join <b>${esc(invite.ledgerName)}</b>. ${mode==='register'?'Create an account to accept.':'Sign in to accept.'}</p></div>` : ''}
      ${cfg.firstUser ? `<div class="note info"><p>This is a new Evenly server. The first account you create here is yours.</p></div>` : ''}
      ${canSignup ? `<div class="seg" role="tablist"><button type="button" class="${mode==='login'?'on':''}" data-mode="login">Sign in</button><button type="button" class="${mode==='register'?'on':''}" data-mode="register">Create account</button></div>` : ''}
      <form id="auth-form" novalidate style="display:flex;flex-direction:column;gap:12px">
        ${mode==='register' ? `<label class="fld">Your name<input id="a-name" maxlength="40" autocomplete="name" placeholder="e.g. Ana Popescu" required></label>` : ''}
        <label class="fld">Username<input id="a-user" maxlength="32" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
        <label class="fld">Password<input id="a-pass" type="password" maxlength="200" autocomplete="${mode==='register'?'new-password':'current-password'}" required></label>
        ${mode==='register' ? `<p class="mut" style="margin:0;font-size:13px">Your name and @username are shown to everyone in the ledgers you join, so they know who added what. Use at least 8 characters for the password.</p>` : ''}
        <p class="err-t" id="a-err" hidden></p>
        <button class="btn primary" type="submit" id="a-go" style="justify-content:center">${mode==='register'?'Create account':'Sign in'}</button>
      </form>
      ${!canSignup ? `<p class="mut" style="margin:0;font-size:13px">New accounts are by invitation. Ask someone already using Evenly for an invite link.</p>` : ''}
      <p class="mut" style="margin:0;font-size:12px">Forgot your password? Ask the person who runs this server to reset it.</p>
    </div>`;
    box.querySelectorAll('[data-mode]').forEach(b=>b.onclick = ()=>{ mode = b.dataset.mode; draw(); });
    $('#a-name')?.focus() ?? $('#a-user').focus();
    $('#auth-form').addEventListener('submit', async ev=>{
      ev.preventDefault();
      const err = m => { const el = $('#a-err'); el.textContent = m; el.hidden = false; };
      const btn = $('#a-go'); btn.disabled = true;
      try {
        if (mode==='register') await api('POST', 'auth/register', {name:$('#a-name').value, username:$('#a-user').value.trim(), password:$('#a-pass').value, invite:invite?.token||null});
        else await api('POST', 'auth/login', {username:$('#a-user').value.trim(), password:$('#a-pass').value});
        box.hidden = true; box.innerHTML = ''; $('#app').hidden = false;
        onDone(mode==='register');
      } catch (e) { btn.disabled = false; err(e.message); }
    });
  };
  draw();
}
