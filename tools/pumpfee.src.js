// Pre-bundled pump.fun creator-fee helpers for the Vercel functions (the SDK's own ESM build can't load in Node).
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
const sdk = rpc => new OnlinePumpSdk(new Connection(rpc, 'confirmed'));
export async function vaultBalance(rpc, creator) { return (await sdk(rpc).getCreatorVaultBalanceBothPrograms(new PublicKey(creator))).toString(); }
export async function collectIxs(rpc, creator, payer) {
  const ixs = await sdk(rpc).collectCoinCreatorFeeInstructions(new PublicKey(creator), new PublicKey(payer));
  return ixs.map(ix => ({ programId: ix.programId.toBase58(), keys: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data).toString('base64') }));
}
