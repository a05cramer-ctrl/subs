// List a coin after launch: checks on-chain that the launcher's whole first buy reached the subs' escrow, then stores it.
import { redis, pipeline, send, isMint, twitchUser } from './_lib.js';
import { checkLaunch } from './_chain.js';
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 200, {});
  if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
  try {
    const { sig, mint, bid, image, name, symbol, sol } = req.body || {};
    if (!isMint(mint) || !sig) throw new Error('mint and sig required');
    if (await redis('EXISTS', 'coin:' + mint)) return send(res, 200, { ok: true, existing: true });
    const ch = await twitchUser({ id: bid }); if (!ch) throw new Error('Twitch channel not found');
    const { amount, creator } = await checkLaunch(sig, mint, ch.id);
    await pipeline([
      ['HSET', 'coin:' + mint, 'mint', mint, 'sig', sig, 'name', String(name).slice(0, 32), 'symbol', String(symbol).slice(0, 10), 'image', image || '', 'bid', ch.id, 'login', ch.login, 'channel', ch.name, 'avatar', ch.image || '', 'total', amount.toString(), 'sol', String(Number(sol) || 0), 'createdAt', Date.now(), 'creator', creator],
      ['LPUSH', 'coins', mint],
      ['SADD', 'channels', ch.id],
      ['SADD', 'ccoins:' + ch.id, mint],
      ['HINCRBYFLOAT', 'stats', 'sol', String(Number(sol) || 0)],
      ['LPUSH', 'events', JSON.stringify({ k: 'launch', mint, symbol: String(symbol).slice(0, 10), channel: ch.name, login: ch.login, sol: Number(sol) || 0, ts: Date.now() })],
      ['LTRIM', 'events', 0, 79],
    ]);
    send(res, 200, { ok: true, total: amount.toString() });
  } catch (e) { send(res, 400, { error: e.message }); }
}
