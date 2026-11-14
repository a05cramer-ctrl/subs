// Sign for your share as a Twitch sub.
// POST {coin, message, signature, token}: the wallet signs "SUBS sign", the browser passes the Twitch login token it got from
// Twitch, we check with Twitch that this account is subscribed to the coin's channel right now, then that Twitch account and
// that wallet join the coin's subs (one each per coin). Signing closes the moment the coin graduates.
import { redis, send, hobj, validateUser, subOf, hashUser } from './_lib.js';
import { graduated } from './_chain.js';
import { parseMsg, verifyWallet } from './_msg.js';
const ip = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
async function limit(key, max, sec) { const n = await redis('INCR', 'rl:' + key); if (n === 1) await redis('EXPIRE', 'rl:' + key, sec); if (n > max) throw new Error('too many tries, wait a bit'); }
const TIER = { 1000: 'Tier 1', 2000: 'Tier 2', 3000: 'Tier 3' };
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 200, {});
  if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
  try {
    const b = req.body || {};
    await limit('ip:' + ip(req), 30, 3600);
    const f = parseMsg(b.message, 'SUBS sign'); verifyWallet(b.message, b.signature, f);
    const c = hobj(await redis('HGETALL', 'coin:' + f.coin)); if (!c.mint) throw new Error('not a SUBS coin');
    if (await graduated(f.coin)) throw new Error('this coin graduated, signing is closed');
    const u = await validateUser(b.token);
    if (!u.scopes.includes('user:read:subscriptions')) throw new Error('log in with Twitch again and allow "view your subscriptions"');
    if (u.id === c.bid) throw new Error("that's the streamer's own account: the streamer gets the creator fees, subs get the coins");
    const sub = await subOf(b.token, c.bid, u.id);
    if (!sub) throw new Error(`${u.login} is not subscribed to ${c.channel} right now`);
    const h = hashUser(u.id);
    if (await redis('HEXISTS', 'tsig:' + f.coin, h)) throw new Error('this Twitch account already signed for this coin');
    if (!(await redis('HSETNX', 'tsig:' + f.coin, h, f.wallet))) throw new Error('this Twitch account already signed for this coin');
    if (!(await redis('HSETNX', 'wsig:' + f.coin, f.wallet, h))) { await redis('HDEL', 'tsig:' + f.coin, h); throw new Error('this wallet already signed for this coin'); }
    await redis('SADD', 'wcoins:' + f.wallet, f.coin);
    await redis('RPUSH', 'signlog:' + f.coin, JSON.stringify({ login: u.login, tier: TIER[sub.tier] || 'Tier 1', gift: sub.gift, wallet: f.wallet, ts: Date.now() }));
    await redis('HINCRBY', 'stats', 'signers', 1);
    await redis('LPUSH', 'events', JSON.stringify({ k: 'sub', mint: f.coin, symbol: c.symbol, channel: c.channel, login: u.login, tier: TIER[sub.tier] || 'Tier 1', ts: Date.now() }));
    await redis('LTRIM', 'events', 0, 79);
    send(res, 200, { ok: true, login: u.login, tier: TIER[sub.tier] || 'Tier 1', gift: sub.gift });
  } catch (e) { send(res, 400, { error: e.message }); }
}
