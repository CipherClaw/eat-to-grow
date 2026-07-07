# Eat To Grow

Browser multiplayer `.io` arena where blocky players eat voxel buildings and props to grow, then use their expanding shadow to consume smaller rivals.

## Run locally

```sh
npm install
npm start
```

Open `http://localhost:3000`.

## Validation

```sh
npm test
PORT=3010 node server.js
curl -s http://127.0.0.1:3010/api/status
```

`GET /api/status` returns `{ "status": "ok", "players": <count> }`.

## Hub integration

Game id: `eat-to-grow`

The browser loads `public/greglab-client.js`, reads the shared greglab identity cookie, and sends the token during `hello`. The server uses `profile.js` with `PROFILE_API_URL` and `PROFILE_API_KEY` when present. If those env vars are missing, guests still play normally.

Linked players report games played once per session, blocks eaten, players eaten, best size, milestone coins, periodic block coins, and player-eat coins.

## Deployment status

GitHub repo: `https://github.com/CipherClaw/eat-to-grow`

Intended domain: `https://eattogrow.greglab.net`

Railway and DNS setup are pending follow-up work.
