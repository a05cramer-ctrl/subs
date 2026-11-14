import { redis, pipeline, send, hobj } from './_lib.js';
import { curve } from './_chain.js';
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 200, {});
  try {
    const mints = await redis('LRANGE', 'coins', 0, 59);
    const rows = await pipeline(mints.flatMap(m => [['HGETALL', 'coin:' + m], ['HLEN', 'tsig:' + m], ['SCARD', 'claimed:' + m]]));
    const list = mints.map((m, i) => { const c = hobj(rows[i * 3]); return { mint: m, name: c.name, symbol: c.symbol, image: c.image, bid: c.bid, login: c.login, channel: c.channel, avatar: c.avatar, sol: Number(c.sol || 0), total: Number(c.total) / 1e6, signers: Number(rows[i * 3 + 1]) || 0, claimed: Number(rows[i * 3 + 2]) || 0, createdAt: Number(c.createdAt) }; });
    const k = await Promise.all(list.map(c => curve(c.mint).catch(() => null)));
    list.forEach((c, i) => { c.graduated = !!k[i]?.complete; c.raised = k[i]?.realSol || 0; });
    send(res, 200, list, 's-maxage=15, stale-while-revalidate=60');
  } catch (e) { send(res, 502, { error: e.message }); }
}
