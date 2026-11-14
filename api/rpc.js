// Solana RPC proxy for the browser (keeps the Helius key server-side).
import { cors, HELIUS } from './_lib.js';
const ALLOW = new Set(['getAccountInfo', 'getMultipleAccounts', 'getLatestBlockhash', 'getSignatureStatuses', 'sendTransaction', 'simulateTransaction', 'getBalance', 'getTokenAccountBalance', 'getMinimumBalanceForRentExemption', 'getEpochInfo', 'getSlot', 'getBlockHeight', 'getTokenAccountsByOwner', 'getParsedAccountInfo', 'getRecentPrioritizationFees', 'getFeeForMessage', 'isBlockhashValid', 'getGenesisHash', 'getVersion']);
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body;
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > 20 || calls.some(c => !ALLOW.has(c?.method))) return res.status(400).json({ error: 'method not allowed' });
  const r = await fetch(HELIUS(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  res.status(r.status).setHeader('content-type', 'application/json');
  res.send(await r.text());
}
