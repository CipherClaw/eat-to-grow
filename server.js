"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const socketIO = require("socket.io");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const TICK_RATE = 30;
const SNAPSHOT_RATE = 10;
const DT = 1 / TICK_RATE;
const WORLD_SIZE = 180;
const HALF_WORLD = WORLD_SIZE / 2;
const BLOCK_REGEN_MS = 25000;
const PLAYER_START_SIZE = 1;
const MIN_PLAYER_SIZE = 0.75;
const SHADOW_EAT_SECONDS = 3;
const GAME_ID = "eat-to-grow";

// greglab-games shared cross-game profile (null when PROFILE_API_URL/KEY unset).
const hub = require("./profile.js").fromEnv(GAME_ID);

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  pingTimeout: 6000,
  pingInterval: 2500,
  transports: ["websocket", "polling"],
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (_req, res) => {
  res.json({ status: "ok", players: players.size });
});

const players = new Map();
const blocks = new Map();
let nextBlockId = 1;
let snapshotAccumulator = 0;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function distance2d(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function sanitizeName(name) {
  const cleaned = String(name || "").replace(/[^\w .-]/g, "").trim().slice(0, 18);
  return cleaned || `Guest${Math.floor(1000 + Math.random() * 9000)}`;
}

function spawnAtEdge() {
  const margin = 10;
  const side = Math.floor(Math.random() * 4);
  const v = randomBetween(-HALF_WORLD + margin, HALF_WORLD - margin);
  if (side === 0) return { x: v, z: -HALF_WORLD + margin };
  if (side === 1) return { x: HALF_WORLD - margin, z: v };
  if (side === 2) return { x: v, z: HALF_WORLD - margin };
  return { x: -HALF_WORLD + margin, z: v };
}

function playerRadius(size) {
  return 0.45 + Math.sqrt(size) * 0.22;
}

function playerHeight(size) {
  return Math.max(1, size);
}

function shadowRadius(size) {
  return playerRadius(size) + 0.9 + size * 0.08;
}

function moveSpeed(size, running) {
  const base = running ? 10.8 : 7.8;
  return clamp(base / (1 + Math.max(0, size - 1) * 0.075), 2.4, base);
}

function addBlock(x, y, z, kind, color, value = 0.055) {
  const id = nextBlockId++;
  const block = {
    id,
    x,
    y,
    z,
    kind,
    color,
    size: 1,
    value,
    active: true,
    respawnAt: 0,
  };
  blocks.set(id, block);
  return block;
}

function addVoxelWall(cx, cz, width, depth, floors, color) {
  const halfW = Math.floor(width / 2);
  const halfD = Math.floor(depth / 2);
  for (let level = 0; level < floors; level++) {
    for (let x = -halfW; x <= halfW; x++) {
      for (let z = -halfD; z <= halfD; z++) {
        const edge = x === -halfW || x === halfW || z === -halfD || z === halfD;
        const windowGap = level > 0 && ((x + z + level) % 4 === 0);
        if (edge && !windowGap) addBlock(cx + x, level + 0.5, cz + z, "building", color, 0.05);
      }
    }
  }
}

function addTree(cx, cz) {
  addBlock(cx, 0.5, cz, "prop", "#775136", 0.04);
  addBlock(cx, 1.5, cz, "prop", "#2f8b46", 0.045);
  addBlock(cx + 1, 1.5, cz, "prop", "#3ba95a", 0.045);
  addBlock(cx - 1, 1.5, cz, "prop", "#3ba95a", 0.045);
  addBlock(cx, 1.5, cz + 1, "prop", "#49b766", 0.045);
  addBlock(cx, 2.5, cz, "prop", "#2f8b46", 0.055);
}

function generateArena() {
  const buildings = [
    [-58, -48, 10, 12, 8, "#a65a47"],
    [-20, -58, 14, 9, 12, "#b18470"],
    [34, -50, 12, 12, 10, "#9a7860"],
    [64, -12, 9, 15, 7, "#b86a4f"],
    [18, 18, 16, 11, 14, "#c08d7a"],
    [-42, 18, 12, 16, 9, "#946c55"],
    [-70, 54, 10, 10, 6, "#b85d42"],
    [48, 55, 14, 10, 11, "#aa8064"],
  ];
  for (const b of buildings) addVoxelWall(...b);

  for (let i = 0; i < 46; i++) {
    addTree(randomBetween(-78, 78), randomBetween(-78, 78));
  }
}

function serializeBlock(block) {
  return {
    id: block.id,
    x: block.x,
    y: block.y,
    z: block.z,
    kind: block.kind,
    color: block.color,
    size: block.size,
    active: block.active,
  };
}

function serializePlayer(player) {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    z: player.z,
    yaw: player.yaw,
    size: player.size,
    color: player.color,
    shadowRadius: shadowRadius(player.size),
    eatenBy: player.eatenBy,
    eatCountdown: player.eatCountdown,
    coins: player.coins,
  };
}

function leaderboard() {
  return [...players.values()]
    .sort((a, b) => b.size - a.size)
    .slice(0, 8)
    .map((p, idx) => ({ rank: idx + 1, id: p.id, name: p.name, size: p.size }));
}

function broadcastSnapshot() {
  io.emit("worldSnapshot", {
    t: Date.now(),
    players: [...players.values()].map(serializePlayer),
    leaderboard: leaderboard(),
  });
}

function makePlayer(socket, name, hubProfile) {
  const spawn = spawnAtEdge();
  const canonicalName = hubProfile?.displayName || name;
  return {
    id: socket.id,
    hubId: hubProfile?.id || null,
    name: sanitizeName(canonicalName),
    x: spawn.x,
    z: spawn.z,
    yaw: 0,
    size: PLAYER_START_SIZE,
    color: `hsl(${Math.floor(Math.random() * 360)} 72% 56%)`,
    input: { forward: 0, strafe: 0, yaw: 0, run: false },
    blocksEaten: 0,
    unreportedBlocks: 0,
    playersEaten: 0,
    bestSize: PLAYER_START_SIZE,
    nextMilestone: 5,
    coins: hubProfile?.coins || 0,
    sessionReported: false,
    nextPeriodicReportAt: Date.now() + 60000,
    eatenBy: null,
    eatCountdown: null,
    shadowContact: new Map(),
  };
}

async function resolveHubProfile(glToken) {
  if (!hub || !glToken) return null;
  return hub.resolve(glToken);
}

function reportHub(player, deltas) {
  if (!hub || !player.hubId) return;
  hub.report(player.hubId, deltas).then((result) => {
    if (!result) return;
    player.coins = result.coins;
    io.to(player.id).emit("walletUpdate", result.coins);
  });
}

function maybeReportProgress(player, reason) {
  if (!player.hubId) return;
  const statsDelta = {};
  if (player.unreportedBlocks > 0) statsDelta.blocksEaten = player.unreportedBlocks;
  if (player.pendingPlayersEaten > 0) statsDelta.playersEaten = player.pendingPlayersEaten;
  const coinsDelta = Math.floor(player.unreportedBlocks / 25) + (player.pendingPlayerCoins || 0);
  const payload = { reason };
  if (coinsDelta > 0) payload.coinsDelta = coinsDelta;
  if (Object.keys(statsDelta).length > 0) payload.statsDelta = statsDelta;
  if (player.size > player.reportedBestSize) {
    player.reportedBestSize = player.size;
    payload.statsSet = { bestSize: Number(player.size.toFixed(1)) };
  }
  if (!player.sessionReported) {
    player.sessionReported = true;
    payload.gamesPlayedDelta = 1;
  }
  if (!payload.coinsDelta && !payload.statsDelta && !payload.statsSet && !payload.gamesPlayedDelta) return;
  player.unreportedBlocks = 0;
  player.pendingPlayersEaten = 0;
  player.pendingPlayerCoins = 0;
  reportHub(player, payload);
}

function consumeBlock(player, block) {
  block.active = false;
  block.respawnAt = Date.now() + BLOCK_REGEN_MS + Math.random() * 15000;
  player.size += block.value;
  player.blocksEaten += 1;
  player.unreportedBlocks += 1;
  player.bestSize = Math.max(player.bestSize, player.size);
  io.emit("blockConsumed", { id: block.id, eaterId: player.id });

  if (player.size >= player.nextMilestone) {
    player.pendingPlayerCoins = (player.pendingPlayerCoins || 0) + 2;
    player.nextMilestone += 5;
    maybeReportProgress(player, "size milestone");
  }
}

function updateMovement(player) {
  const input = player.input;
  player.yaw = Number.isFinite(input.yaw) ? input.yaw : player.yaw;
  let forward = clamp(input.forward || 0, -1, 1);
  let strafe = clamp(input.strafe || 0, -1, 1);
  const len = Math.hypot(forward, strafe);
  if (len > 1) {
    forward /= len;
    strafe /= len;
  }

  const speed = moveSpeed(player.size, input.run);
  const sin = Math.sin(player.yaw);
  const cos = Math.cos(player.yaw);
  const dx = (sin * forward + cos * strafe) * speed * DT;
  const dz = (cos * forward - sin * strafe) * speed * DT;
  const radius = playerRadius(player.size);
  player.x = clamp(player.x + dx, -HALF_WORLD + radius, HALF_WORLD - radius);
  player.z = clamp(player.z + dz, -HALF_WORLD + radius, HALF_WORLD - radius);
}

function updateBlockEating(player) {
  const reach = playerRadius(player.size) + 0.9;
  const height = playerHeight(player.size);
  for (const block of blocks.values()) {
    if (!block.active) continue;
    if (block.y + block.size / 2 > height + 0.02) continue;
    const d = Math.hypot(player.x - block.x, player.z - block.z);
    if (d <= reach) consumeBlock(player, block);
  }
}

function respawnPlayer(player) {
  const spawn = spawnAtEdge();
  player.x = spawn.x;
  player.z = spawn.z;
  player.size = PLAYER_START_SIZE;
  player.eatenBy = null;
  player.eatCountdown = null;
  player.shadowContact.clear();
}

function updatePlayerEating() {
  const now = Date.now();
  for (const victim of players.values()) {
    let activePredator = null;
    let strongestRatio = 1;
    for (const eater of players.values()) {
      if (eater.id === victim.id) continue;
      if (eater.size < victim.size * 1.15) continue;
      if (distance2d(eater, victim) > shadowRadius(eater.size)) continue;
      const ratio = eater.size / Math.max(victim.size, MIN_PLAYER_SIZE);
      if (ratio > strongestRatio) {
        strongestRatio = ratio;
        activePredator = eater;
      }
    }

    if (!activePredator) {
      victim.eatenBy = null;
      victim.eatCountdown = null;
      victim.shadowContact.clear();
      continue;
    }

    if (!victim.shadowContact.has(activePredator.id)) {
      victim.shadowContact.clear();
      victim.shadowContact.set(activePredator.id, now);
    }

    const start = victim.shadowContact.get(activePredator.id);
    const elapsed = (now - start) / 1000;
    const remaining = Math.max(0, SHADOW_EAT_SECONDS - elapsed);
    const drain = (0.12 + activePredator.size * 0.004) * DT;
    const actualDrain = Math.min(drain, Math.max(0, victim.size - MIN_PLAYER_SIZE));
    victim.size -= actualDrain;
    activePredator.size += actualDrain * 0.85;
    activePredator.bestSize = Math.max(activePredator.bestSize, activePredator.size);
    victim.eatenBy = activePredator.id;
    victim.eatCountdown = remaining;

    if (remaining <= 0) {
      const absorbed = Math.max(0.5, victim.size * 0.45);
      activePredator.size += absorbed;
      activePredator.playersEaten += 1;
      activePredator.pendingPlayersEaten = (activePredator.pendingPlayersEaten || 0) + 1;
      activePredator.pendingPlayerCoins = (activePredator.pendingPlayerCoins || 0) + 8;
      activePredator.bestSize = Math.max(activePredator.bestSize, activePredator.size);
      io.emit("playerConsumed", { eaterId: activePredator.id, victimId: victim.id });
      respawnPlayer(victim);
      maybeReportProgress(activePredator, "player eaten");
    }
  }
}

function tick() {
  const now = Date.now();
  for (const player of players.values()) {
    updateMovement(player);
    updateBlockEating(player);
    if (now >= player.nextPeriodicReportAt) {
      player.nextPeriodicReportAt = now + 60000;
      maybeReportProgress(player, "periodic play");
    }
  }
  updatePlayerEating();

  for (const block of blocks.values()) {
    if (!block.active && block.respawnAt <= now) {
      block.active = true;
      io.emit("blockRespawned", serializeBlock(block));
    }
  }

  snapshotAccumulator += DT;
  if (snapshotAccumulator >= 1 / SNAPSHOT_RATE) {
    snapshotAccumulator = 0;
    broadcastSnapshot();
  }
}

io.on("connection", (socket) => {
  socket.on("hello", async (data = {}) => {
    if (players.has(socket.id)) return;
    const profile = await resolveHubProfile(data.glToken);
    const player = makePlayer(socket, data.name || "Guest", profile);
    player.reportedBestSize = PLAYER_START_SIZE;
    players.set(socket.id, player);

    if (player.hubId) {
      maybeReportProgress(player, "session start");
    }

    socket.emit("worldInit", {
      selfId: socket.id,
      worldSize: WORLD_SIZE,
      blocks: [...blocks.values()].map(serializeBlock),
      players: [...players.values()].map(serializePlayer),
      leaderboard: leaderboard(),
      coins: player.coins,
    });
    io.emit("playerJoined", serializePlayer(player));
  });

  socket.on("input", (input = {}) => {
    const player = players.get(socket.id);
    if (!player) return;
    player.input = {
      forward: Number(input.forward) || 0,
      strafe: Number(input.strafe) || 0,
      yaw: Number(input.yaw) || 0,
      run: Boolean(input.run),
    };
  });

  socket.on("disconnect", () => {
    const player = players.get(socket.id);
    if (player) maybeReportProgress(player, "disconnect");
    players.delete(socket.id);
    io.emit("playerLeft", socket.id);
  });
});

generateArena();
setInterval(tick, 1000 / TICK_RATE);

server.listen(PORT, HOST, () => {
  console.log(`Eat To Grow server listening on ${HOST}:${PORT}`);
});
