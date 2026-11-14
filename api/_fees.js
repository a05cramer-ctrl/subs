// Creator fees → the streamer. Each coin's fee wallet (feeKey) is its pump.fun creator. SUBS collects the coin's
// creator fees into it, and the Twitch channel's owner pulls everything it ever received by logging in with Twitch.
// Owed = (fee wallet balance − 0.001 SOL rent reserve + everything already paid out) − what was already paid.
import { PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { vaultBalance, collectIxs } from './_pumpfee.js';
import { HELIUS } from './_lib.js';
import { conn, escrow, feeKey } from './_chain.js';
import { redis, pipeline, hobj } from './_lib.js';
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const RESERVE = 1_000_000n, MIN_COLLECT = 2_000_000n;
export const MIN_PAY = 100_000n;
const memo = t => new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(t) });

async function confirmSig(c, sig) {
  for (let i = 0; i < 40; i++) {
    const st = (await c.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error('fee collect failed');
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('fee collect not confirmed yet, try again in a minute');
}
// fees still sitting in pump.fun's creator vaults (curve + AMM) for this coin
export async function uncollected(mint) {
  return BigInt(await vaultBalance(HELIUS(), feeKey(mint).publicKey.toBase58()));
}
// pull the coin's creator fees into its fee wallet (the escrow pays the network fee)
export async function collect(mint) {
  if ((await uncollected(mint).catch(() => 0n)) < MIN_COLLECT) return null;
  if (!(await redis('SET', 'collectlock:' + mint, '1', 'NX', 'EX', 60))) return null;
  const c = conn(), fk = feeKey(mint), kp = escrow();
  const ixs = (await collectIxs(HELIUS(), fk.publicKey.toBase58(), kp.publicKey.toBase58())).map(ix => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map(k => ({ ...k, pubkey: new PublicKey(k.pubkey) })), data: Buffer.from(ix.data, 'base64') }));
  const tx = new Transaction().add(...ixs, memo('sub:collect'));
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash('confirmed')).blockhash;
  const need = new Set(tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures).map(String));
  tx.sign(...[kp, fk].filter(k => need.has(k.publicKey.toBase58())));
  return confirmSig(c, await c.sendRawTransaction(tx.serialize(), { maxRetries: 3 }));
}
// record one fee payout after checking on-chain that the fee wallet signed it and how much it sent
export async function record(mint, sig) {
  const fk = feeKey(mint).publicKey.toBase58();
  if (await redis('SISMEMBER', 'feetx:' + mint, sig)) return null;
  const t = await conn().getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
  if (!t || t.meta?.err) return null;
  const keys = t.transaction.message.staticAccountKeys ? t.transaction.message.staticAccountKeys.map(String) : t.transaction.message.accountKeys.map(String);
  const i = keys.indexOf(fk);
  if (i < 0 || i >= t.transaction.message.header.numRequiredSignatures) return null;
  const line = (t.meta.logMessages || []).find(l => l.includes('sub:f:'));
  const m = line && line.match(/sub:f:(\w+):(\d+)/);
  if (!m) return null;
  const sent = BigInt(t.meta.preBalances[i]) - BigInt(t.meta.postBalances[i]);
  const amt = BigInt(m[2]) < sent ? BigInt(m[2]) : sent;
  if (!(await redis('SADD', 'feetx:' + mint, sig))) return null;
  await pipeline([['HINCRBY', 'feepaid:' + mint, m[1], amt.toString()], ['HINCRBY', 'feepaid:' + mint, '_total', amt.toString()], ['HINCRBYFLOAT', 'stats', 'fees', (Number(amt) / 1e9).toFixed(9)]]);
  return { tag: m[1], amt };
}
// catch payouts that landed but were never confirmed back to us
async function reconcile(mint) {
  const sigs = await conn().getSignaturesForAddress(feeKey(mint).publicKey, { limit: 1000 }).catch(() => []);
  for (const s of sigs) if (!s.err && s.memo && s.memo.includes('sub:f:')) await record(mint, s.signature);
}
export async function feeState(mint, n, tag, { live = true } = {}) {
  if (live) await reconcile(mint);
  const fk = feeKey(mint).publicKey;
  const [bal, led, pend] = await Promise.all([conn().getBalance(fk).then(BigInt).catch(() => 0n), redis('HGETALL', 'feepaid:' + mint).then(hobj), uncollected(mint).catch(() => 0n)]);
  const paid = BigInt(led._total || 0), mine = tag ? BigInt(led[tag] || 0) : 0n;
  const avail = bal > RESERVE ? bal - RESERVE : 0n;
  const lifetime = avail + paid + pend;
  let owed = n ? (avail + paid) / BigInt(n) - mine : 0n;
  if (owed > avail) owed = avail;
  if (owed < 0n) owed = 0n;
  return { wallet: fk.toBase58(), lifetime, paid, pending: pend, owed, estimate: n ? lifetime / BigInt(n) - mine : lifetime, mine };
}
// a payout of `lamports` from the coin's fee wallet to the claimer; the claimer pays the network fee
export async function buildFeeTx({ mint, to, lamports, tag }) {
  const fk = feeKey(mint), c = conn(), dest = new PublicKey(to);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: fk.publicKey, toPubkey: dest, lamports: BigInt(lamports) }), memo('sub:f:' + tag + ':' + lamports));
  tx.feePayer = dest;
  tx.recentBlockhash = (await c.getLatestBlockhash('confirmed')).blockhash;
  tx.partialSign(fk);
  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}
