// At graduation the inheritance is split once: total ÷ every Twitch sub who signed before graduation.
// Nobody signed → the escrow burns it. Signing closes the moment the curve completes, so the count can't move after.
import { redis, hobj } from './_lib.js';
import { curve, burnAll } from './_chain.js';
export async function settle(mint, c) {
  c = c || hobj(await redis('HGETALL', 'coin:' + mint));
  if (!c.mint) throw new Error('not a SUBS coin');
  const k = await curve(mint).catch(() => null);
  const live = { graduated: !!k?.complete, raised: k?.realSol || 0 };
  if (c.per !== undefined || !live.graduated) return { ...c, ...live };
  const n = Number(await redis('HLEN', 'tsig:' + mint)) || 0;
  if (!n) {
    if (await redis('SET', 'burnlock:' + mint, '1', 'NX', 'EX', 600)) {
      const sig = await burnAll(mint, c.total);
      await redis('HSET', 'coin:' + mint, 'per', '0', 'owners', '0', 'burned', sig);
      return { ...c, ...live, per: '0', owners: '0', burned: sig };
    }
    return { ...c, ...live };
  }
  const per = (BigInt(c.total) / BigInt(n)).toString();
  await redis('HSETNX', 'coin:' + mint, 'per', per);
  await redis('HSETNX', 'coin:' + mint, 'owners', String(n));
  return { ...hobj(await redis('HGETALL', 'coin:' + mint)), ...live };
}
