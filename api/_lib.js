// shared helpers for SUBS functions (files starting with _ are not routes on Vercel)
export const HELIUS = () => `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}
export function send(res, code, body, cache) {
  cors(res);
  if (cache) res.setHeader('Cache-Control', cache);
  res.status(code).json(body);
}
export async function getJSON(url, opt) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { ...opt, headers: { accept: 'application/json', 'user-agent': 'SUBS/1.0', ...(opt?.headers || {}) }, signal: AbortSignal.timeout(9000) });
    if (r.status === 429 && i < 2) { await new Promise(s => setTimeout(s, 700 * (i + 1))); continue; }
    if (!r.ok) { const e = new Error(`${r.status} ${url.split('?')[0]}`); e.status = r.status; throw e; }
    return r.json();
  }
}
export async function rpc(method, params) {
  const r = await fetch(HELIUS(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}
// any Vercel-connected Upstash store works, whatever prefix it was connected with (KV_, STORAGE_, …)
const envEnd = suf => process.env[Object.keys(process.env).find(k => k.endsWith(suf) && !k.includes('READ_ONLY'))];
const RURL = () => process.env.UPSTASH_REDIS_REST_URL || envEnd('_REST_API_URL');
const RTOK = () => process.env.UPSTASH_REDIS_REST_TOKEN || envEnd('_REST_API_TOKEN');
export const SITE = () => process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '');
// every key is namespaced so SUBS can share a Redis store with other projects safely
const P = c => c.length > 1 ? [c[0], 'sub:' + c[1], ...c.slice(2)] : c;
export async function redis(...cmd) {
  cmd = P(cmd);
  const r = await fetch(RURL(), { method: 'POST', headers: { Authorization: `Bearer ${RTOK()}`, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
export async function pipeline(cmds) {
  if (!cmds.length) return [];
  const r = await fetch(RURL() + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${RTOK()}`, 'content-type': 'application/json' }, body: JSON.stringify(cmds.map(P)) });
  return (await r.json()).map(x => x.result);
}
export const hobj = arr => { const o = {}; for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o; };
export const isMint = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || '');


// ---------- Twitch ----------
import crypto from 'node:crypto';
export const TWITCH_ID = () => process.env.TWITCH_CLIENT_ID || process.env.TWITCHID;
const TWITCH_SECRET = () => process.env.TWITCH_CLIENT_SECRET || process.env.TWITCHSECRET;
export const hashUser = id => crypto.createHash('sha256').update('subs|' + String(id)).digest('hex');
// app access token (client credentials), cached in Redis until shortly before it expires
async function appToken(fresh) {
  if (!fresh) { const c = await redis('GET', 'tw:app'); if (c) return c; }
  if (!TWITCH_ID() || !TWITCH_SECRET()) throw new Error('Twitch is not set up yet');
  const r = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body: new URLSearchParams({ client_id: TWITCH_ID(), client_secret: TWITCH_SECRET(), grant_type: 'client_credentials' }), signal: AbortSignal.timeout(9000) });
  const j = await r.json(); if (!j.access_token) throw new Error('Twitch login for the app failed');
  await redis('SET', 'tw:app', j.access_token, 'EX', Math.max(300, (j.expires_in || 3600) - 900));
  return j.access_token;
}
// GET a Helix endpoint; with no user token it uses the app token
export async function helix(path, userToken) {
  for (let i = 0; i < 2; i++) {
    const tok = userToken || await appToken(i > 0);
    const r = await fetch('https://api.twitch.tv/helix/' + path, { headers: { 'Client-Id': TWITCH_ID(), Authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(9000) });
    if (r.status === 401 && !userToken && i === 0) continue;
    if (r.status === 404) return null;
    if (!r.ok) { const e = new Error('Twitch ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }
}
const shapeUser = u => u && { id: u.id, login: u.login, name: u.display_name, image: u.profile_image_url, kind: u.broadcaster_type || '', about: String(u.description || '').slice(0, 200) };
export async function twitchUser({ id, login }) {
  const q = id ? 'id=' + encodeURIComponent(id) : 'login=' + encodeURIComponent(String(login).toLowerCase());
  const j = await helix('users?' + q);
  return shapeUser(j?.data?.[0]) || null;
}
export async function followers(id) { const j = await helix('channels/followers?first=1&broadcaster_id=' + encodeURIComponent(id)).catch(() => null); return j?.total ?? null; }
export async function searchChannels(q) {
  q = String(q || '').trim(); if (q.length < 2) return [];
  const j = await helix('search/channels?first=12&query=' + encodeURIComponent(q));
  return (j?.data || []).map(c => ({ id: c.id, login: c.broadcaster_login, name: c.display_name, image: c.thumbnail_url, live: !!c.is_live, game: c.game_name || '' }));
}
// check a user token the browser got from Twitch: it must belong to our app and carry the sub scope
export async function validateUser(token) {
  if (!token || !/^[a-z0-9]{20,40}$/i.test(token)) throw new Error('log in with Twitch first');
  const r = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + token }, signal: AbortSignal.timeout(8000) });
  if (r.status === 401) throw new Error('Twitch login expired, log in again');
  const v = await r.json();
  if (v.client_id !== TWITCH_ID()) throw new Error('that Twitch login is not from SUBS');
  return { id: v.user_id, login: v.login, scopes: v.scopes || [] };
}
// is this Twitch user subscribed to this channel right now? → { tier: '1000'|'2000'|'3000', gift } or null
export async function subOf(token, broadcasterId, userId) {
  const j = await helix(`subscriptions/user?broadcaster_id=${encodeURIComponent(broadcasterId)}&user_id=${encodeURIComponent(userId)}`, token);
  const d = j?.data?.[0]; return d ? { tier: d.tier, gift: !!d.is_gift } : null;
}
