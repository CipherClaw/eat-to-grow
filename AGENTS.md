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

## Deployment

Railway metadata files are present for a later deployment task:

- `railway.json`
- `nixpacks.toml`
- `Procfile`

Do not touch Railway or DNS unless the user explicitly asks for deployment.

## Durable Notes

- Keep durable status in `STATUS.md` and forward-looking work in `PLAN.md`.
- `CLAUDE.md` should remain a symlink to `AGENTS.md`.
- Do not commit secrets or profile API keys.
