// Image proxy for Twitch avatars and IPFS logos, so they can be drawn into the coin-logo canvas (needs CORS).
import { cors } from './_lib.js';
const OK = /^https:\/\/(static-cdn\.jtvnw\.net|ipfs\.filebase\.io)\//;
export default async function handler(req, res) {
  cors(res);
  const u = String(req.query.u || '');
  if (!OK.test(u)) return res.status(400).end();
  try {
    const r = await fetch(u, { headers: { 'user-agent': 'SUBS/1.0' }, signal: AbortSignal.timeout(7000) });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.startsWith('image/')) return res.status(502).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 6e6) return res.status(502).end();
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, s-maxage=604800, max-age=86400, immutable');
    res.status(200).send(buf);
  } catch { res.status(502).end(); }
}
