// SUBS launch: one pump.fun transaction from the launcher's own wallet.
// create_v2 (creator = the coin's own SUBS fee wallet) + the launcher's first buy + every bought coin sent to the students' escrow + memo sub:<twitch channel id>.
import { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import BN from 'bn.js';

const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const DEC = 6;
const conn = cfg => new Connection(cfg.RPC || (location.origin + (cfg.API || '') + '/api/rpc'), { commitment: 'confirmed' });

async function confirm(connection, sig) {
  // poll (no websocket through the proxy)
  for (let i = 0; i < 60; i++) {
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error('transaction failed: ' + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('not confirmed in time, check your wallet');
}

// tokens a first buy of `sol` gets on a fresh curve (what goes to the holders)
async function quote({ cfg, sol, connection }) {
  connection = connection || conn(cfg);
  const online = new OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig().catch(() => null)]);
  const solAmount = new BN(Math.round(sol * 1e9));
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: NATIVE_MINT });
  return { global, solAmount, amount };
}

async function build({ cfg, connection, owner, name, symbol, uri, sol, collection, opts = { cb: 1, memo: 1 } }) {
  const user = new PublicKey(owner);
  const escrow = new PublicKey(cfg.DISTRIBUTOR);
  const mint = Keypair.generate();
  // the coin's creator is its own SUBS fee wallet, so its creator fees go to the streamer
  const [{ global, solAmount, amount }, fee] = await Promise.all([quote({ cfg, sol, connection }),
    fetch((cfg.API_BASE || location.origin) + (cfg.API || '') + '/api/config?fee=' + mint.publicKey.toBase58()).then(r => r.json())]);
  if (!fee?.FEE) throw new Error('fee wallet not ready, try again');
  if (amount.isZero()) throw new Error('dev buy too small');
  const ixs = await PUMP_SDK.createV2AndBuyInstructions({ global, mint: mint.publicKey, name, symbol, uri, creator: new PublicKey(fee.FEE), user, amount, solAmount, mayhemMode: false });
  const fromAta = getAssociatedTokenAddressSync(mint.publicKey, user, true, TOKEN_2022_PROGRAM_ID);
  const escrowAta = getAssociatedTokenAddressSync(mint.publicKey, escrow, true, TOKEN_2022_PROGRAM_ID);
  const tx = new Transaction();
  if (opts.cb) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }));
  tx.add(...ixs,
    createAssociatedTokenAccountIdempotentInstruction(user, escrowAta, escrow, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(fromAta, mint.publicKey, escrowAta, user, BigInt(amount.toString()), DEC, [], TOKEN_2022_PROGRAM_ID));
  if (opts.memo) tx.add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('sub:' + collection) }));
  tx.feePayer = user;
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.recentBlockhash = blockhash;
  if (opts.legacy) { tx.partialSign(mint); return { tx, mint: mint.publicKey.toBase58(), amount: amount.toString(), keypair: mint }; }
  // v0 with the SUBS lookup table: the launch only fits in one transaction this way
  const alt = cfg.ALT ? (await connection.getAddressLookupTable(new PublicKey(cfg.ALT))).value : null;
  if (!alt) throw new Error('launch table not set up yet');
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: tx.instructions }).compileToV0Message([alt]);
  const vtx = new VersionedTransaction(msg); vtx.sign([mint]);
  return { tx: vtx, mint: mint.publicKey.toBase58(), amount: amount.toString() };
}

async function launch({ cfg, provider, owner, name, symbol, uri, sol, collection }) {
  const connection = conn(cfg);
  const { tx, mint, amount } = await build({ cfg, connection, owner, name, symbol, uri, sol, collection });
  const signed = await provider.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
  await confirm(connection, sig);
  return { mint, sig, amount };
}

// Build the real launch transaction for any wallet and simulate it on mainnet (nothing is signed by the wallet or sent).
async function dryRun({ cfg, rpc, owner, sol = 1, collection = 'test' }) {
  const connection = rpc ? new Connection(rpc, 'confirmed') : conn(cfg);
  const { tx, mint, amount } = await build({ cfg, connection, owner, name: 'Subs Test', symbol: 'TEST', uri: 'https://example.com/m.json', sol, collection });
  const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))[0];
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: [curve.toBase58()] } });
  const cd = sim.value.accounts?.[0]?.data?.[0];
  const creator = cd ? new PublicKey(Buffer.from(cd, 'base64').subarray(49, 81)).toBase58() : null;
  return { mint, amount, creator, bytes: tx.serialize().length, err: sim.value.err, logs: (sim.value.logs || []).slice(-14), units: sim.value.unitsConsumed };
}

// Sign and send a claim the server built (the claimer pays the network fee; the SUBS escrow co-signs the payout).
async function sendTx({ cfg, provider, b64 }) {
  const connection = conn(cfg);
  const tx = Transaction.from(Buffer.from(b64, 'base64'));
  const signed = await provider.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
  return confirm(connection, sig);
}
async function preview({ cfg, sol }) { const { amount } = await quote({ cfg, sol }); return amount.toString(); }
async function tableKeys({ cfg }) {
  const connection = conn(cfg);
  const a = await build({ cfg, connection, owner: Keypair.generate().publicKey.toBase58(), name: 'A', symbol: 'A', uri: 'https://x.y/a.json', sol: 1, collection: 'a', opts: { cb: 1, memo: 1, legacy: 1 } });
  const b = await build({ cfg, connection, owner: Keypair.generate().publicKey.toBase58(), name: 'B', symbol: 'B', uri: 'https://x.y/b.json', sol: 1, collection: 'b', opts: { cb: 1, memo: 1, legacy: 1 } });
  const ka = a.tx.compileMessage().accountKeys.map(String), kb = new Set(b.tx.compileMessage().accountKeys.map(String));
  return ka.filter(k => kb.has(k));
}
async function sizes({ cfg, owner }) {
  const connection = conn(cfg), out = {};
  for (const [k, opts] of Object.entries({ full: { cb: 1, memo: 1 }, noCb: { memo: 1 }, noMemo: { cb: 1 }, bare: {} })) {
    const { tx } = await build({ cfg, connection, owner, opts: { ...opts, legacy: 1 }, name: 'Subs Test', symbol: 'SUBS', uri: 'https://ipfs.filebase.io/ipfs/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sol: 1, collection: 'mad_lads' });
    const m = tx.serializeMessage(); out[k] = { bytes: m.length + 1 + 64 * 2, ixs: tx.instructions.length, keys: tx.compileMessage().accountKeys.length };
  }
  return out;
}
window.CmpLaunch = { launch, dryRun, sendTx, preview, sizes, tableKeys };
