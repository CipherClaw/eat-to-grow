"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const socketIO = require("socket.io");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const TICK_RATE = 30;
const SNAPSHOT_RATE = 20;
const DT = 1 / TICK_RATE;
const WORLD_SIZE = 260;
const HALF_WORLD = WORLD_SIZE / 2;
const BLOCK_REGEN_MS = 25000;
const PLAYER_START_SIZE = 1;
const MIN_PLAYER_SIZE = 0.75;
const SHADOW_EAT_SECONDS = 3;
const FLOOR_SPACING = 10;
const PLAYER_VISUAL_BASE_SCALE = 0.55;
const MAX_CLIENT_POSITION_STEP = 12;
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
const activeBlockCells = new Map();
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
  return 0.2 + Math.sqrt(size) * 0.17;
}

function playerHeight(size) {
  return Math.max(1.2, Math.pow(size, 0.45) * 2.45 * PLAYER_VISUAL_BASE_SCALE);
}

function shadowRadius(size) {
  return playerRadius(size) + 0.9 + size * 0.08;
}

function cellKey(x, z) {
  return `${Math.floor(x)},${Math.floor(z)}`;
}

function addToCellIndex(index, block) {
  const key = cellKey(block.x, block.z);
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(block);
  return key;
}

function removeFromCellIndex(index, key, block) {
  if (!key) return;
  const cell = index.get(key);
  if (!cell) return;
  cell.delete(block);
  if (cell.size === 0) index.delete(key);
}

function indexActiveBlock(block) {
  if (!block.active) return;
  block._activeCellKey = addToCellIndex(activeBlockCells, block);
}

function unindexActiveBlock(block) {
  removeFromCellIndex(activeBlockCells, block._activeCellKey, block);
  block._activeCellKey = null;
}

function blocksNear(index, x, z, radius) {
  const found = [];
  const seen = new Set();
  const minX = Math.floor(x - radius - 1);
  const maxX = Math.floor(x + radius + 1);
  const minZ = Math.floor(z - radius - 1);
  const maxZ = Math.floor(z + radius + 1);
  for (let cx = minX; cx <= maxX; cx++) {
    for (let cz = minZ; cz <= maxZ; cz++) {
      const cell = index.get(`${cx},${cz}`);
      if (!cell) continue;
      for (const block of cell) {
        if (seen.has(block.id)) continue;
        seen.add(block.id);
        found.push(block);
      }
    }
  }
  return found;
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
  indexActiveBlock(block);
  return block;
}

function addVoxelWall(cx, cz, width, depth, floors, color) {
  const halfW = Math.floor(width / 2);
  const halfD = Math.floor(depth / 2);
  const windowColor = "#bfe4f5";
  for (let level = 0; level < floors; level++) {
    for (let x = -halfW; x <= halfW; x++) {
      for (let z = -halfD; z <= halfD; z++) {
        const edge = x === -halfW || x === halfW || z === -halfD || z === halfD;
        if (!edge) continue;
        const nearCorner = (Math.abs(x) === halfW && Math.abs(z) >= halfD - 1) || (Math.abs(z) === halfD && Math.abs(x) >= halfW - 1);
        const upperFloor = level >= 2 && level % 2 === 0;
        const windowPattern = upperFloor && !nearCorner && ((x * 3 + z * 5 + level) % 7 === 0);
        const kind = windowPattern ? "window" : "building";
        addBlock(cx + x, level + 0.5, cz + z, kind, windowPattern ? windowColor : color, 0.05);
      }
    }
  }
  for (let top = FLOOR_SPACING; top <= floors; top += FLOOR_SPACING) {
    const y = top - 0.5;
    for (let x = -halfW + 1; x <= halfW - 1; x++) {
      for (let z = -halfD + 1; z <= halfD - 1; z++) {
        const stairwell = Math.abs(x) <= 1 && Math.abs(z) <= 1;
        if (!stairwell) addBlock(cx + x, y, cz + z, "building", color, 0.035);
      }
    }
  }
  const stairs = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
  ];
  for (let step = 0; step < floors; step++) {
    const [x, z] = stairs[step % stairs.length];
    addBlock(cx + x, step + 0.5, cz + z, "building", color, 0.03);
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
    [-104, -88, 16, 18, 18, "#a65a47"],
    [-58, -98, 20, 14, 30, "#b18470"],
    [10, -94, 17, 19, 24, "#9a7860"],
    [80, -84, 19, 17, 38, "#b86a4f"],
    [106, -24, 14, 22, 20, "#a86d55"],
    [58, 28, 22, 18, 42, "#c08d7a"],
    [2, 14, 18, 16, 28, "#946c55"],
    [-60, 30, 17, 22, 24, "#aa8064"],
    [-108, 82, 16, 16, 14, "#b85d42"],
    [-28, 102, 21, 15, 34, "#8f7462"],
    [48, 100, 18, 18, 30, "#b77962"],
    [108, 78, 16, 20, 18, "#9e6250"],
  ];
  for (const b of buildings) addVoxelWall(...b);

  for (let i = 0; i < 90; i++) {
    addTree(randomBetween(-118, 118), randomBetween(-118, 118));
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
    y: player.y,
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
    y: 0,
    z: spawn.z,
    vy: 0,
    yaw: 0,
    size: PLAYER_START_SIZE,
    color: `hsl(${Math.floor(Math.random() * 360)} 72% 56%)`,
    input: { yaw: 0, run: false, jump: false },
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
  unindexActiveBlock(block);
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

function updateBlockEating(player) {
  const radius = playerRadius(player.size);
  const reach = radius + 1.15;
  const footY = player.y - 0.6;
  const headY = player.y + playerHeight(player.size) + 0.2;
  for (const block of blocksNear(activeBlockCells, player.x, player.z, reach)) {
    if (!block.active) continue;
    const blockBottom = block.y - block.size / 2;
    const blockTop = block.y + block.size / 2;
    if (blockTop < footY || blockBottom > headY) continue;
    const d = Math.hypot(player.x - block.x, player.z - block.z);
    const touching = Math.abs(player.x - block.x) <= radius + 0.58 && Math.abs(player.z - block.z) <= radius + 0.58;
    if (d <= reach || touching) consumeBlock(player, block);
  }
}

function respawnPlayer(player) {
  const spawn = spawnAtEdge();
  player.x = spawn.x;
  player.y = 0;
  player.z = spawn.z;
  player.vy = 0;
  player.size = PLAYER_START_SIZE;
  player.eatenBy = null;
  player.eatCountdown = null;
  player.shadowContact.clear();
  io.to(player.id).emit("playerReset", { x: player.x, y: player.y, z: player.z });
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
      indexActiveBlock(block);
      io.emit("blockRespawned", serializeBlock(block));
    }
  }

  snapshotAccumulator += DT;
  if (snapshotAccumulator >= 1 / SNAPSHOT_RATE) {
    snapshotAccumulator = 0;
    broadcastSnapshot();
  }
}

function applyClientPosition(player, input) {
  const radius = playerRadius(player.size);
  let x = Number(input.x);
  let y = Number(input.y);
  let z = Number(input.z);
  const yaw = Number(input.yaw);
  const vy = Number(input.vy);

  if (!Number.isFinite(x)) x = player.x;
  if (!Number.isFinite(y)) y = player.y;
  if (!Number.isFinite(z)) z = player.z;

  x = clamp(x, -HALF_WORLD + radius, HALF_WORLD - radius);
  y = Math.max(0, y);
  z = clamp(z, -HALF_WORLD + radius, HALF_WORLD - radius);

  const dx = x - player.x;
  const dy = y - player.y;
  const dz = z - player.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance > MAX_CLIENT_POSITION_STEP) {
    const scale = MAX_CLIENT_POSITION_STEP / distance;
    x = player.x + dx * scale;
    y = player.y + dy * scale;
    z = player.z + dz * scale;
  }

  player.x = x;
  player.y = y;
  player.z = z;
  player.yaw = Number.isFinite(yaw) ? yaw : player.yaw;
  player.vy = Number.isFinite(vy) ? vy : player.vy;
  player.input = {
    yaw: player.yaw,
    run: Boolean(input.run),
    jump: Boolean(input.jump),
  };
}

function removePlayer(socket, reason) {
  const player = players.get(socket.id);
  if (!player) return;
  maybeReportProgress(player, reason);
  players.delete(socket.id);
  io.emit("playerLeft", socket.id);
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
    applyClientPosition(player, input);
  });

  socket.on("leaveGame", () => {
    removePlayer(socket, "leave game");
  });

  socket.on("disconnect", () => {
    removePlayer(socket, "disconnect");
  });
});

generateArena();
setInterval(tick, 1000 / TICK_RATE);

server.listen(PORT, HOST, () => {
  console.log(`Eat To Grow server listening on ${HOST}:${PORT}`);
});
