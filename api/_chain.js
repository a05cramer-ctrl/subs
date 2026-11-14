// On-chain helpers: pump.fun curve status, launch check, owners' escrow payouts and burns (Token-2022 coins).
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createBurnCheckedInstruction, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import crypto from 'node:crypto';
import { HELIUS } from './_lib.js';

export const DEC = 6;
export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const conn = () => new Connection(HELIUS(), 'confirmed');
export function escrow() { return Keypair.fromSecretKey(bs58.decode(process.env.DISTRIBUTOR_SECRET)); }
// Every coin gets its own fee wallet, derived from the escrow key + the mint. It is the coin's pump.fun creator,
// so the coin's creator fees land in a vault only SUBS can collect, and only for that coin's streamer.
export function feeKey(mint) { return Keypair.fromSeed(crypto.createHmac('sha256', process.env.DISTRIBUTOR_SECRET).update('sub-fee:' + mint).digest()); }
export const escrowAta = mint => getAssociatedTokenAddressSync(new PublicKey(mint), escrow().publicKey, true, TOKEN_2022_PROGRAM_ID);

// pump.fun bonding curve: 8-byte discriminator, 5 x u64 reserves/supply, then `complete` (bool) at byte 48
export const curvePda = mint => PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], new PublicKey(PUMP))[0];
export async function curve(mint) {
  const acc = await conn().getAccountInfo(curvePda(mint));
  if (!acc) return null;
  const d = acc.data;
  return { realSol: Number(d.readBigUInt64LE(32)) / 1e9, complete: d[48] === 1, creator: new PublicKey(d.subarray(49, 81)).toBase58() };
}
export async function graduated(mint) { const c = await curve(mint); return !!c && !!c.complete; }

// Was this coin created on pump.fun with the launcher's whole first buy sent to the SUBS escrow, tagged sub:<twitch channel id>, in the same transaction?
export async function checkLaunch(sig, mint, appid) {
  let t = null;
  for (let i = 0; i < 8 && !t; i++) { t = await conn().getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null); if (!t) await new Promise(r => setTimeout(r, 1500)); }
  if (!t) throw new Error('launch transaction not found yet');
  if (t.meta?.err) throw new Error('launch transaction failed');
  const logs = t.meta?.logMessages || [];
  if (!logs.some(l => l.includes('Instruction: CreateV2') || l.includes('Instruction: Create'))) throw new Error('not a pump.fun create');
  if (!logs.some(l => l.includes('"sub:' + appid + '"') || l.endsWith('sub:' + appid))) throw new Error('not a SUBS launch for this channel');
  const keys = t.transaction.message.accountKeys.map(k => (k.pubkey || k).toString());
  if (!keys.includes(mint)) throw new Error('mint not in this transaction');
  const esc = escrow().publicKey.toBase58();
  const bal = arr => (arr || []).filter(b => b.mint === mint && b.owner === esc).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  const got = bal(t.meta.postTokenBalances) - bal(t.meta.preTokenBalances);
  if (got <= 0n) throw new Error('no coins reached the students escrow');
  const creator = keys[0];
  const kept = (t.meta.postTokenBalances || []).filter(b => b.mint === mint && b.owner === creator).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  if (kept > 0n) throw new Error('launcher kept part of the first buy');
  const k = await curve(mint);
  if (!k || k.creator !== feeKey(mint).publicKey.toBase58()) throw new Error("creator fees don't go to the coin's SUBS fee wallet");
  return { amount: got, creator };
}

// One owner's share as a transaction the CLAIMER pays for (fee + their token account rent). The escrow only co-signs.
export async function buildShareTx({ mint, to, raw, tag }) {
  const kp = escrow(), c = conn(), m = new PublicKey(mint), dest = new PublicKey(to);
  const toAta = getAssociatedTokenAddressSync(m, dest, true, TOKEN_2022_PROGRAM_ID);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(dest, toAta, dest, m, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(escrowAta(mint), m, toAta, kp.publicKey, BigInt(raw), DEC, [], TOKEN_2022_PROGRAM_ID),
    new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('sub:' + tag) })
  );
  tx.feePayer = dest;
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.partialSign(kp);
  return { tx: tx.serialize({ requireAllSignatures: false }).toString('base64'), lastValidBlockHeight };
}
export async function paidOnChain(mint, tag) {
  const sigs = await conn().getSignaturesForAddress(escrowAta(mint), { limit: 1000 }).catch(() => []);
  return sigs.find(s => !s.err && s.memo && s.memo.includes('sub:' + tag))?.signature || null;
}
// Nobody signed before graduation: the escrow burns the whole inheritance (escrow pays the tiny fee).
export async function burnAll(mint, raw) {
  const kp = escrow(), c = conn(), m = new PublicKey(mint);
  const tx = new Transaction().add(
    createBurnCheckedInstruction(escrowAta(mint), m, kp.publicKey, BigInt(raw), DEC, [], TOKEN_2022_PROGRAM_ID),
    new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('sub:burn:no-subs-signed') })
  );
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(kp);
  return c.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
}
