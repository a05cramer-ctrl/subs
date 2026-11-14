// Logo + metadata JSON to IPFS through Filebase. Returns the metadata uri for the pump.fun mint.
import { send, SITE } from './_lib.js';
const ADD = 'https://rpc.filebase.io/api/v0/add?cid-version=1';
const GW = cid => `https://ipfs.filebase.io/ipfs/${cid}`;
async function add(blob, name) {
  const fd = new FormData(); fd.append('file', blob, name);
  const r = await fetch(ADD, { method: 'POST', headers: { Authorization: `Bearer ${process.env.FILEBASE_IPFS_TOKEN}` }, body: fd });
  if (!r.ok) throw new Error('ipfs upload failed ' + r.status);
  const txt = await r.text(); return JSON.parse(txt.trim().split('\n').pop()).Hash;
}
export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 200, {});
  if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
  try {
    const { name, symbol, image, login, channelName } = req.body || {};
    if (!name || !symbol || !/^data:image\/(png|jpeg|webp);base64,/.test(image || '')) throw new Error('name, symbol and image are required');
    const [head, data] = image.split(',');
    const type = head.slice(5, head.indexOf(';'));
    const imgCid = await add(new Blob([Buffer.from(data, 'base64')], { type }), 'logo.' + type.split('/')[1]);
    const meta = {
      name: String(name).slice(0, 32), symbol: String(symbol).slice(0, 10), image: GW(imgCid),
      description: `Launched on SUBS for ${channelName || 'a Twitch streamer'}. The launcher's whole first buy went to the channel's subs: everyone subscribed to twitch.tv/${login || ''} who signs in before graduation gets an equal share when the coin graduates. The creator fees go to the streamer.`,
      extensions: { website: SITE() },
      subs: { channel: channelName || '', twitch: 'https://twitch.tv/' + String(login || '') }
    };
    const metaCid = await add(new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'metadata.json');
    send(res, 200, { uri: GW(metaCid), image: GW(imgCid) });
  } catch (e) { send(res, 400, { error: e.message }); }
}
