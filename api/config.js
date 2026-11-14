// GET: public SUBS addresses for the page (holders' escrow + the launch lookup table).
// POST {keys}: one time, creates the address lookup table that makes the launch transaction fit (escrow pays ~0.006 SOL rent).
import { PublicKey, TransactionMessage, VersionedTransaction, AddressLookupTableProgram } from '@solana/web3.js';
import { send, redis, TWITCH_ID } from './_lib.js';
import { escrow, conn, feeKey } from './_chain.js';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export default async function handler(req, res) {
  try {
    const kp = escrow();
    if (req.method === 'POST') {
      const have = (await redis('GET', 'alt')) || (process.env.ALT_ADDRESS || '6yL15rDYkpycH3BvuLFeV3qx5ukYgCRi6zgQM8pWExob');
      if (have) return send(res, 200, { ALT: have, existing: true });
      const keys = [...new Set((req.body?.keys || []).map(String))];
      if (!keys.includes(PUMP) || keys.length < 5 || keys.length > 30) throw new Error('bad key list');
      const pks = keys.map(k => new PublicKey(k));
      const c = conn();
      const slot = (await c.getSlot('finalized')) - 20;
      const [createIx, alt] = AddressLookupTableProgram.createLookupTable({ authority: kp.publicKey, payer: kp.publicKey, recentSlot: slot });
      const extendIx = AddressLookupTableProgram.extendLookupTable({ lookupTable: alt, authority: kp.publicKey, payer: kp.publicKey, addresses: pks });
      const { blockhash } = await c.getLatestBlockhash('confirmed');
      const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: [createIx, extendIx] }).compileToV0Message();
      const tx = new VersionedTransaction(msg); tx.sign([kp]);
      const sig = await c.sendTransaction(tx, { maxRetries: 3 });
      for (let i = 0; i < 30; i++) { const st = (await c.getSignatureStatuses([sig])).value[0]; if (st?.err) throw new Error('alt tx failed ' + JSON.stringify(st.err)); if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') break; await new Promise(r => setTimeout(r, 1000)); }
      await redis('SET', 'alt', alt.toBase58());
      return send(res, 200, { ALT: alt.toBase58(), sig });
    }
    const fv = String(req.query?.feevault || '');
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(fv)) { res.setHeader('cache-control', 's-maxage=10'); return send(res, 200, { FEE: feeKey(fv).publicKey.toBase58(), pending: (await (await import('./_fees.js')).uncollected(fv)).toString() }); }
    const fm = String(req.query?.fee || '');
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(fm)) { res.setHeader('cache-control', 's-maxage=86400'); return send(res, 200, { FEE: feeKey(fm).publicKey.toBase58() }); }
    res.setHeader('cache-control', 's-maxage=30');
    send(res, 200, { DISTRIBUTOR: kp.publicKey.toBase58(), TWITCH: TWITCH_ID() || '', ALT: (await redis('GET', 'alt').catch(() => null)) || (process.env.ALT_ADDRESS || '6yL15rDYkpycH3BvuLFeV3qx5ukYgCRi6zgQM8pWExob') || '' });
  } catch (e) { send(res, 400, { error: e.message }); }
}
