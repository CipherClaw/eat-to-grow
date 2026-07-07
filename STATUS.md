# Status

- First playable multiplayer prototype implemented.
- Server is authoritative for movement, size, block consumption, block respawn, shadow-based player eating, and hub rewards.
- Static Three.js client renders a blocky arena, voxel buildings, props, third-person player camera, HUD, leaderboard, wallet readout, and player-eating countdown overlay.
- Server-authoritative movement now includes corrected A/D strafing, Space jump physics with gravity, solid building collision, reliable contact eating, and standable multi-floor voxel buildings.
- The arena is expanded to 260 units with taller buildings, edible floor slabs every 6 units, more props, and client rendering/camera support for player vertical position while shadows stay on the ground.
- Gameplay tuning on 2026-07-07 made small players faster, matched collision height to visual scale, expanded buildings to taller 6-unit floors with edible glass windows, and replaced camera pitch with orbit elevation for stronger look-down views.
- Shared greglab-games profile integration is wired through the copied `profile.js` and `public/greglab-client.js`.
- GitHub repository: `CipherClaw/eat-to-grow`.
- Production domain: `https://eattogrow.greglab.net`.
- Railway deployment is live in project `eat-to-grow`, service `eat-to-grow`, environment `production`.
- `https://eattogrow.greglab.net/api/status` returns `{"status":"ok","players":0}` as of 2026-07-07.
- Route53 DNS is configured in hosted zone `ZUYHF7A0SK9ZQ`; Railway custom domain TLS validation is active.
- `PROFILE_API_URL` and `PROFILE_API_KEY` are set on the Railway service for hub integration.
