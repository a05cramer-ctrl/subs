// GET ?q=  → Twitch channels matching the search (for the launch form)
// GET ?login= or ?id= → one channel, its follower count and every SUBS coin launched for it
import { redis, pipeline, send, hobj, searchChannels, twitchUser, followers } from './_lib.js';
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 200, {});
  try {
    if (req.query.q !== undefined) return send(res, 200, await searchChannels(req.query.q), 's-maxage=60');
    const u = await twitchUser({ id: req.query.id, login: req.query.login });
    if (!u) return send(res, 404, { error: 'no Twitch channel by that name' });
    const mints = (await redis('SMEMBERS', 'ccoins:' + u.id)) || [];
    const rows = mints.length ? await pipeline(mints.map(m => ['HGETALL', 'coin:' + m])) : [];
    send(res, 200, { ...u, followers: await followers(u.id), coins: rows.map(hobj).map(c => ({ mint: c.mint, name: c.name, symbol: c.symbol, image: c.image })) }, 's-maxage=60');
  } catch (e) { send(res, e.status === 400 ? 400 : 502, { error: e.message }); }
}
