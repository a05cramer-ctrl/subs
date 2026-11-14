// GET ?wallet= : every coin this wallet signed for as a sub, and its share.
// POST {message, signature, kind:'coins'}: a sub's one-time equal share of the dev buy, after graduation.
// POST {message, signature, kind:'fees', token}: the streamer (logged in with Twitch as the channel owner) pulls the coin's
//   creator fees, any time, as often as more come in.
import crypto from 'node:crypto';
import { rpc, redis, pipeline, send, isMint, validateUser } from './_lib.js';
import { buildShareTx, paidOnChain, escrowAta } from './_chain.js';
import { settle } from './_settle.js';
import { parseMsg, verifyWallet } from './_msg.js';
import { collect, feeState, buildFeeTx, record, MIN_PAY } from './_fees.js';
const tagOf = h => 's' + crypto.createHash('sha256').update(String(h)).digest('hex').slice(0, 16);
const sol = l => Number(l) / 1e9;
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 200, {});
  try {
    if (req.method === 'GET') {
      const w = String(req.query.wallet || ''); if (!isMint(w)) throw new Error('bad wallet');
      const mints = (await redis('SMEMBERS', 'wcoins:' + w)) || [];
      const items = await Promise.all(mints.map(async m => {
        const c = await settle(m).catch(() => null); if (!c?.mint) return null;
        const h = await redis('HGET', 'wsig:' + m, w);
        const claimed = !!(await redis('SISMEMBER', 'claimed:' + m, tagOf(h)));
        const signers = Number(await redis('HLEN', 'tsig:' + m)) || 0;
        const share = c.per !== undefined ? Number(c.per) / 1e6 : Number(c.total) / 1e6 / Math.max(1, signers);
        return { mint: m, name: c.name, symbol: c.symbol, image: c.image, channel: c.channel, login: c.login, avatar: c.avatar, graduated: c.graduated, raised: c.raised, signers, share, final: c.per !== undefined,
          status: claimed ? 'claimed' : c.per !== undefined && c.per !== '0' ? 'claimable' : 'locked' };
      }));
      return send(res, 200, { items: items.filter(Boolean) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
    if (req.body?.confirm) return await confirm(req, res);
    const { message, signature } = req.body || {};
    const kind = req.body?.kind === 'fees' ? 'fees' : 'coins';
    const f = parseMsg(message, 'SUBS claim'); verifyWallet(message, signature, f);
    if (kind === 'fees') {
      const c0 = await redis('HGET', 'coin:' + f.coin, 'bid'); if (!c0) throw new Error('not a SUBS coin');
      const u = await validateUser(req.body.token);
      if (u.id !== c0) throw new Error('only the streamer can claim the creator fees: log in with the channel\'s own Twitch account');
      const tag = 'streamer';
      if (!(await redis('SET', 'feelock:' + f.coin, f.wallet, 'NX', 'EX', 120))) throw new Error('a fee claim is already open, try again in two minutes');
      try {
        await collect(f.coin).catch(() => null);
        const s = await feeState(f.coin, 1, tag);
        if (s.owed < MIN_PAY) throw new Error(s.mine > 0n ? 'nothing new yet, fees keep coming in as people trade' : 'no fees yet, they come in as people trade');
        const tx = await buildFeeTx({ mint: f.coin, to: f.wallet, lamports: s.owed.toString(), tag });
        return send(res, 200, { tx, tag, kind, sol: sol(s.owed) });
      } catch (e) { await redis('DEL', 'feelock:' + f.coin); throw e; }
    }
    const c = await settle(f.coin);
    if (!c.graduated) throw new Error('locked until the coin graduates on pump.fun');
    if (c.per === undefined) throw new Error('settling, try again in a minute');
    if (c.per === '0') throw new Error('nothing to claim');
    const h = await redis('HGET', 'wsig:' + f.coin, f.wallet);
    if (!h) throw new Error('this wallet did not sign for this coin before graduation');
    const tag = tagOf(h);
    if (await redis('SISMEMBER', 'claimed:' + f.coin, tag)) throw new Error('already claimed');
    if (await paidOnChain(f.coin, tag)) { await redis('SADD', 'claimed:' + f.coin, tag); throw new Error('already claimed'); }
    if (!(await redis('SET', 'claimlock:' + f.coin + ':' + tag, f.wallet, 'NX', 'EX', 120))) throw new Error('a claim is already open, try again in a minute');
    const { tx } = await buildShareTx({ mint: f.coin, to: f.wallet, raw: c.per, tag });
    send(res, 200, { tx, tag, kind });
  } catch (e) { send(res, 400, { error: e.message }); }
}
async function confirm(req, res) {
  const { confirm: sig, coin: mint, tag, kind } = req.body;
  if (!/^(s[0-9a-f]{16}|streamer)$/.test(tag || '')) throw new Error('bad tag');
  if (kind === 'fees') {
    let r = null;
    for (let i = 0; i < 8 && !r; i++) { r = await record(mint, sig).catch(() => null); if (!r) await new Promise(s => setTimeout(s, 1500)); }
    await redis('DEL', 'feelock:' + mint);
    return send(res, 200, { sig, sol: r ? sol(r.amt) : null });
  }
  let t = null;
  for (let i = 0; i < 8 && !t; i++) { t = await rpc('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null); if (!t) await new Promise(r => setTimeout(r, 1500)); }
  if (!t) throw new Error('transaction not found yet');
  if (t.meta?.err) throw new Error('transaction failed');
  if (!(t.meta?.logMessages || []).some(l => l.includes('sub:' + tag))) throw new Error('not a SUBS payout');
  if (!t.transaction.message.accountKeys.includes(escrowAta(mint).toBase58())) throw new Error('not a SUBS payout');
  if (!(await redis('SADD', 'claimed:' + mint, tag))) return send(res, 200, { sig, already: true });
  await pipeline([['HINCRBY', 'stats', 'claims', 1], ['DEL', 'claimlock:' + mint + ':' + tag]]);
  send(res, 200, { sig });
}
