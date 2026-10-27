# PEAK multiplayer server (Cloudflare)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/verdjs/peak-mp-server)

This repo is only the multiplayer server (no game files). Click the button to put your own free copy on your Cloudflare account.

A Photon-compatible server, so the game's own Photon client plays online without a Photon
account, app id or CCU cap. The game page redirects the game's connection to Photon's
name server here (`MP_SERVER_DEFAULT`, or `?mpserver=wss://…` per visit).

- `/ns`, `/master`: name and master server, answered by the Worker itself.
- `/game/<key>`: game server, one Durable Object per room (`GameRoom` → `src/room.js`).

Rooms live in memory only. A room is gone when its last player leaves. Deploying a new version
disconnects games in progress.

```bash
npm install
npm run dev                      # local server on ws://127.0.0.1:8787
```

## Deploy

```bash
npx wrangler login
npm run deploy
```

Then, in the game, click the **Server** button (bottom left) and paste your address, like
`wss://peak-mp-server.<you>.workers.dev`. Everyone who joins your game has to paste the same address,
because a room only exists on the server that created it.

Cost (rough estimate, see https://developers.cloudflare.com/durable-objects/platform/pricing/):
on the Free plan Durable Objects get 100,000 requests a day, and incoming WebSocket messages
count 20 to 1. A player sends ~15 messages a second (pings, movement, RPCs), so a 4-player room
is ~3 requests a second, about 9 hours of play a day. The $5 Workers Paid plan raises the limits
far beyond that.
