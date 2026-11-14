import { redis, send, hobj } from './_lib.js';
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 200, {});
  try {
    const [coins, channels, h, ev] = await Promise.all([redis('LLEN', 'coins'), redis('SCARD', 'channels'), redis('HGETALL', 'stats'), redis('LRANGE', 'events', 0, 39)]);
    const s = hobj(h);
    send(res, 200, { coins, channels, signers: Number(s.signers || 0), claims: Number(s.claims || 0), sol: Number(s.sol || 0), fees: Number(s.fees || 0), events: (ev || []).map(x => JSON.parse(x)) }, 's-maxage=10');
  } catch (e) { send(res, 502, { error: e.message }); }
}
