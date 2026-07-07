# Game Eat To Grow

## Purpose

Eat To Grow is a browser multiplayer `.io` game built with Node.js, Express, Socket.IO, and a no-build Three.js client. Players eat voxel city blocks to grow, then use a size-scaled shadow footprint to consume smaller players.

- Discord channel: `#games-eattogrow`
- Project path: `/srv/codex-work/projects/game-eatToGrow`
- GitHub repo: `https://github.com/CipherClaw/eat-to-grow`
- Intended domain: `https://eattogrow.greglab.net`
- Hub game id: `eat-to-grow`

## Commands

```sh
npm install
npm start
npm test
```

Health check:

```sh
curl -s http://127.0.0.1:3000/api/status
```

## Architecture

- `server.js` is authoritative for positions, movement clamping, player sizes, block consumption, block respawn, shadow-based player eating, and hub reward reporting.
- `public/index.html`, `public/js/main.js`, and `public/css/style.css` are the static browser client.
- The client sends only input and identity. It renders snapshots and confirmed block/player events from the server.
- `profile.js` is copied from DestructionArea and reads `PROFILE_API_URL` / `PROFILE_API_KEY` at runtime.
- `public/greglab-client.js` is copied from `greglab-games/sdk/greglab-client.js`.

## Hub Integration

The client reads the greglab identity cookie with `GreglabGames.getIdentity()` and sends `{ glToken, name }` during `socket.emit("hello", ...)`. The server resolves linked players with:

```js
const hub = require("./profile.js").fromEnv("eat-to-grow");
```

Guests and missing hub env vars are fully supported. Linked players report games played, blocks eaten, players eaten, best size, and coin awards.

## Railway

- Project: `eat-to-grow` (id `94a7dc54-a84e-420b-9564-af7f7295f204`)
- Service: `eat-to-grow` (id `a2bb9848-c60e-43c6-9139-a3912ba1f596`)
- Environment: `production` (id `f25cf729-38b0-47a6-834f-553618bb692e`)
- Railway URL: https://eat-to-grow-production.up.railway.app
- Public URL: https://eattogrow.greglab.net
- Builder: NIXPACKS (`railway.json` start command `npm start`, `nixpacks.toml` present)
- Deploy convention: deploy to Railway after committed production changes. Use `/srv/codex-work/shared/scripts/railway-with-token.sh up --service eat-to-grow --environment production --detach` from the project dir, then verify deployment status and `/api/status`.
- DNS: `eattogrow.greglab.net` is a CNAME in Route53 zone `ZUYHF7A0SK9ZQ`
  pointing to `vfrhdmxn.up.railway.app`. Railway custom domain id
  `5f65f61b-2109-484f-abff-491e806a1ba3` uses the default target port; TLS
  ownership validation required a `_railway-verify.eattogrow.greglab.net` TXT
  record. Do not store the TXT value, Railway token, or `PROFILE_API_KEY` in this file.

## Durable Notes

- Keep durable status in `STATUS.md` and forward-looking work in `PLAN.md`.
- `CLAUDE.md` should remain a symlink to `AGENTS.md`.
- Do not commit secrets or profile API keys.
