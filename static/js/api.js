// Thin fetch wrapper. All URLs are relative, so the app works under whatever secret prefix nginx serves it from.

export class ApiError extends Error {
  constructor(status, message){ super(message); this.status = status; }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn){ onUnauthorized = fn; }

export async function api(method, path, body, {raw=false, contentType} = {}){
  const headers = {'X-Evenly':'1'};
  let payload;
  if (raw) { payload = body; if (contentType) headers['Content-Type'] = contentType; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch('api/'+path, {method, headers, body:payload, credentials:'same-origin'}); }
  catch { throw new ApiError(0, 'Could not reach Evenly. Check your connection and try again.'); }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status===401 && !path.startsWith('auth/')) onUnauthorized();
    let msg = data?.detail;
    if (Array.isArray(msg)) msg = 'Some of the values are not valid. Check the form and try again.';
    throw new ApiError(res.status, msg || (res.status===429 ? 'Too many requests. Wait a moment and try again.' : 'Something went wrong. Try again.'));
  }
  return data;
}
