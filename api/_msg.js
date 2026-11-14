// wallet-signed messages: "<HEAD>\ncoin:…\nwallet:…\nts:…", valid for 10 minutes
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { isMint } from './_lib.js';
export const parseMsg = (message, head) => {
  if (!String(message).startsWith(head + '\n')) throw new Error('bad message');
  return Object.fromEntries(String(message).split('\n').slice(1).map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]));
};
export function verifyWallet(message, signature, f) {
  if (!f.coin || !f.wallet || !f.ts || !isMint(f.coin) || !isMint(f.wallet)) throw new Error('bad message');
  if (Math.abs(Date.now() - Number(f.ts)) > 10 * 60 * 1000) throw new Error('message expired, sign again');
  if (!nacl.sign.detached.verify(new TextEncoder().encode(message), Buffer.from(signature, 'base64'), bs58.decode(f.wallet))) throw new Error('signature does not match the wallet');
}
