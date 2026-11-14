# SUBS

Launch a pump.fun coin for any Twitch streamer. The launcher's whole dev buy goes to the channel's subs in the same transaction; subs log in with Twitch and sign before graduation, then split it equally. Each coin's pump.fun creator is its own fee wallet, claimable only by the channel's own Twitch account.

- `api/` Vercel functions (Twitch Helix checks, launch verification, settle, claims, streamer fees)
- `index.html` the site (built from `tools/launch-src` + the page source), `auth.html` the Twitch login return page
- Env: `HELIUS_API_KEY`, `FILEBASE_IPFS_TOKEN`, `DISTRIBUTOR_SECRET`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, Upstash Redis (`*_REST_API_URL` / `*_REST_API_TOKEN`)
