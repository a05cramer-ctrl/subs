// One coin: its channel, the inheritance, every sub who signed (the live alert feed), the split and the streamer's fees.
import { redis, pipeline, send, hobj } from './_lib.js';
import { settle } from './_settle.js';
import { feeState } from './_fees.js';
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 200, {});
  try {
    const mint = String(req.query.mint || '');
    const c0 = hobj(await redis('HGETALL', 'coin:' + mint));
    if (!c0.mint) return send(res, 404, { error: 'not a SUBS coin' });
    const c = await settle(mint, c0);
    const [log, signers, claimed] = await pipeline([['LRANGE', 'signlog:' + mint, -500, -1], ['HLEN', 'tsig:' + mint], ['SCARD', 'claimed:' + mint]]);
    const total = Number(c.total) / 1e6, n = Number(signers) || 0;
    const fs = await feeState(mint, 1, 'streamer', { live: false }).catch(() => null);
    send(res, 200, {
      mint: c.mint, name: c.name, symbol: c.symbol, image: c.image, bid: c.bid, login: c.login, channel: c.channel, avatar: c.avatar, sol: Number(c.sol || 0), total, creator: c.creator, createdAt: Number(c.createdAt),
      graduated: c.graduated, raised: c.raised, signers: n, claimed: Number(claimed) || 0, final: c.per !== undefined, burned: c.burned || null,
      fees: fs ? { wallet: fs.wallet, total: Number(fs.lifetime) / 1e9, paid: Number(fs.paid) / 1e9, open: Number(fs.estimate > 0n ? fs.estimate : 0n) / 1e9 } : null,
      share: c.per !== undefined ? Number(c.per) / 1e6 : total / Math.max(1, n),
      wall: (log || []).map(r => { const x = JSON.parse(r); return { login: x.login, tier: x.tier, gift: !!x.gift, wallet: x.wallet.slice(0, 4) + '…' + x.wallet.slice(-4), ts: x.ts }; }),
    }, 's-maxage=8');
  } catch (e) { send(res, 502, { error: e.message }); }
}
