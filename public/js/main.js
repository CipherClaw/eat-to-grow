(async function () {
"use strict";

const THREE = await import("three");
const socket = io();
const canvas = document.getElementById("game");
const startPanel = document.getElementById("start");
const playButton = document.getElementById("playButton");
const nameInput = document.getElementById("nameInput");
const playerNameText = document.getElementById("playerNameText");
const hud = document.getElementById("hud");
const sizeReadout = document.getElementById("sizeReadout");
const walletReadout = document.getElementById("walletReadout");
const leaderboardList = document.getElementById("leaderboardList");
const eatOverlay = document.getElementById("eatOverlay");
const eatOverlayText = document.getElementById("eatOverlayText");
const eatCountdown = document.getElementById("eatCountdown");
const actionFeed = document.getElementById("actionFeed");
const eatToast = document.getElementById("eatToast");
const hubLinkStart = document.getElementById("hubLinkStart");
const escHint = document.getElementById("escHint");
const pauseMenu = document.getElementById("pauseMenu");
const resumeButton = document.getElementById("resumeButton");
const exitLobbyButton = document.getElementById("exitLobbyButton");
const lobbyStatus = document.getElementById("lobbyStatus");
const staminaFill = document.getElementById("staminaFill");
const staminaBar = document.getElementById("staminaBar");

const identity = window.GreglabGames?.getIdentity?.() || { token: null, name: null };
const lobbyUrl = window.GreglabGames?.lobbyUrl?.() || "https://games.greglab.net";
hubLinkStart.href = lobbyUrl;
nameInput.value = identity.name || "";
playerNameText.textContent = identity.name || "Guest";

let selfId = null;
let worldSize = 180;
let joined = false;
let yaw = 0;
let pitch = 0.18;
let walletCoins = null;
let localPos = { x: 0, y: 0, z: 0 };
let localVy = 0;
let localReady = false;
let localSize = 1;
let localDead = false;
let lastFrameTime = performance.now();
let stamina = 1;
let sprintLocked = false;
let stuckTimer = 0;
let stuckBestPenetration = Infinity;

const keys = new Set();
const blocks = new Map();
const solidBlockCells = new Map();
const predictedBlockEats = new Map();
const players = new Map();
let lobbyStatusTimer = null;
let pointerLockRetryTimer = null;
const cameraRaycaster = new THREE.Raycaster();
const cameraRayDirection = new THREE.Vector3();
const cameraHitCandidates = [];

const scene = new THREE.Scene();
scene.background = new THREE.Color("#70c8ee");
scene.fog = new THREE.Fog("#70c8ee", 140, 340);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 500);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

const sun = new THREE.DirectionalLight("#fff4d7", 2.2);
sun.position.set(45, 80, 35);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 260;
sun.shadow.camera.left = -155;
sun.shadow.camera.right = 155;
sun.shadow.camera.top = 155;
sun.shadow.camera.bottom = -155;
scene.add(sun);
scene.add(new THREE.HemisphereLight("#bfeaff", "#596345", 1.7));

const ground = new THREE.Mesh(
  new THREE.BoxGeometry(worldSize, 0.3, worldSize),
  new THREE.MeshStandardMaterial({ color: "#59646a", roughness: 0.9 })
);
ground.position.y = -0.15;
ground.receiveShadow = true;
scene.add(ground);

const roadLines = new THREE.Group();
scene.add(roadLines);

const wallGroup = new THREE.Group();
scene.add(wallGroup);

const blockGeometry = new THREE.BoxGeometry(1, 1, 1);
const materialCache = new Map();
const windowMaterial = new THREE.MeshStandardMaterial({
  color: "#bfe4f5",
  transparent: true,
  opacity: 0.8,
  roughness: 0.18,
  metalness: 0.02,
  emissive: "#6baec8",
  emissiveIntensity: 0.16,
});

const GRAVITY = 22;
const JUMP_IMPULSE = 11.8;
const FLOOR_SPACING = 10;
const GROUND_EPSILON = 0.08;
const STEP_TOLERANCE = 0.34;
const PLAYER_VISUAL_BASE_SCALE = 0.55;
const SPRINT_DRAIN_PER_SECOND = 0.34;
const SPRINT_RECHARGE_PER_SECOND = 0.24;
const SPRINT_MIN_CHARGE_TO_START = 0.18;
const BLOCK_EAT_REACH_EXTRA = 1.15;
const BLOCK_EAT_TOUCH_EXTRA = 0.58;
const BLOCK_EAT_FOOT_OFFSET = 0.6;
const BLOCK_EAT_HEAD_EXTRA = 0.2;
const PREDICTED_EAT_REVERT_MS = 1500;
const NAME_LABEL_BASE_WIDTH = 3.4;
const NAME_LABEL_BASE_HEIGHT = 0.85;
const NAME_LABEL_MIN_SCALE = 1.0;
const NAME_LABEL_MAX_SCALE = 4.5;
const UNSTUCK_NUDGE_SPEED = 2.2;
const UNSTUCK_HARD_RECOVERY_SECONDS = 2.75;
const UNSTUCK_PROGRESS_EPSILON = 0.015;
const UNSTUCK_RECOVERY_MAX_STEP = 11.4;
const UNSTUCK_OPEN_SCAN_STEP = 0.75;
const UNSTUCK_EDGE_RECOVERY_MARGIN = 4;
const UNSTUCK_EDGE_RECOVERY_STEP = 4;
const EAT_PARTICLE_COUNT = 36;
const EAT_PARTICLE_RATE = 34;
const EAT_PARTICLE_LIFETIME = 0.75;
const CAMERA_OCCLUSION_MIN_STANDOFF = 2.8;

const eatParticleMaterial = new THREE.PointsMaterial({
  size: 0.28,
  vertexColors: true,
  transparent: true,
  opacity: 0.95,
  depthWrite: false,
});

function material(color) {
  if (!materialCache.has(color)) {
    materialCache.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.82 }));
  }
  return materialCache.get(color);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isFiniteVector3(vector) {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function cellKey(x, z) {
  return `${Math.floor(x)},${Math.floor(z)}`;
}

function isSolidBlock(block) {
  return block.kind === "building" || block.kind === "window";
}

function addToSolidIndex(block) {
  if (!block.active || !isSolidBlock(block)) return;
  const key = cellKey(block.x, block.z);
  if (!solidBlockCells.has(key)) solidBlockCells.set(key, new Set());
  solidBlockCells.get(key).add(block);
  block._solidCellKey = key;
}

function removeFromSolidIndex(block) {
  if (!block?._solidCellKey) return;
  const cell = solidBlockCells.get(block._solidCellKey);
  if (cell) {
    cell.delete(block);
    if (cell.size === 0) solidBlockCells.delete(block._solidCellKey);
  }
  block._solidCellKey = null;
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

function playerRadius(size) {
  return 0.2 + Math.sqrt(size) * 0.17;
}

function playerHeight(size) {
  return Math.max(1.2, Math.pow(size, 0.45) * 2.45 * PLAYER_VISUAL_BASE_SCALE);
}

function playerScale(size) {
  return Math.max(0.3, Math.pow(size, 0.45) * PLAYER_VISUAL_BASE_SCALE);
}

function moveSpeed(size, running) {
  const base = running ? 46 : 30;
  const floor = running ? 18 : 12;
  const decay = 1 + (Math.sqrt(Math.max(1, size)) - 1) * 0.16;
  return clamp(base / decay, floor, base);
}

function verticalOverlapsPlayer(size, footY, block) {
  const blockBottom = block.y - block.size / 2;
  const blockTop = block.y + block.size / 2;
  const headY = footY + playerHeight(size);
  return blockTop > footY + GROUND_EPSILON && blockBottom < headY - GROUND_EPSILON;
}

function blockMatchesServerEatBand(size, y, x, z, block) {
  const radius = playerRadius(size);
  const reach = radius + BLOCK_EAT_REACH_EXTRA;
  const footY = y - BLOCK_EAT_FOOT_OFFSET;
  const headY = y + playerHeight(size) + BLOCK_EAT_HEAD_EXTRA;
  const blockBottom = block.y - block.size / 2;
  const blockTop = block.y + block.size / 2;
  if (blockTop < footY || blockBottom > headY) return false;
  const d = Math.hypot(x - block.x, z - block.z);
  const touching = Math.abs(x - block.x) <= radius + BLOCK_EAT_TOUCH_EXTRA && Math.abs(z - block.z) <= radius + BLOCK_EAT_TOUCH_EXTRA;
  return d <= reach || touching;
}

function movingIntoBlock(fromX, fromZ, dx, dz, block) {
  const moveLen = Math.hypot(dx, dz);
  if (moveLen <= 0.0001) return false;
  const towardX = block.x - fromX;
  const towardZ = block.z - fromZ;
  const centerDot = (towardX * dx + towardZ * dz) / moveLen;
  const currentDistance = Math.hypot(towardX, towardZ);
  const nextDistance = Math.hypot(block.x - (fromX + dx), block.z - (fromZ + dz));
  return centerDot > 0.02 || nextDistance < currentDistance - 0.001;
}

function canPredictEatBlock(size, y, x, z, dx, dz, block) {
  if (!block.active || !isSolidBlock(block)) return false;
  if (!blockMatchesServerEatBand(size, y, x, z, block)) return false;
  const blockTop = block.y + block.size / 2;
  if (blockTop <= y + STEP_TOLERANCE) return false;
  return movingIntoBlock(localPos.x, localPos.z, dx, dz, block);
}

function markBlockPredictedEaten(block) {
  removeFromSolidIndex(block);
  block.active = false;
  const mesh = blocks.get(block.id);
  if (mesh) mesh.visible = false;
  predictedBlockEats.set(block.id, performance.now() + PREDICTED_EAT_REVERT_MS);
}

function predictLocalBlockEating(dx, dz, x, z) {
  if (Math.hypot(dx, dz) <= 0.0001) return;
  const radius = playerRadius(localSize);
  const reach = radius + BLOCK_EAT_REACH_EXTRA;
  for (const block of blocksNear(solidBlockCells, x, z, reach)) {
    if (canPredictEatBlock(localSize, localPos.y, x, z, dx, dz, block)) markBlockPredictedEaten(block);
  }
}

function clearPredictedEat(id) {
  predictedBlockEats.delete(id);
}

function restoreExpiredPredictedEats(now) {
  for (const [id, expiresAt] of predictedBlockEats) {
    if (now < expiresAt) continue;
    predictedBlockEats.delete(id);
    const mesh = blocks.get(id);
    if (!mesh) continue;
    const block = mesh.userData.block;
    if (block.active) continue;
    block.active = true;
    mesh.visible = true;
    addToSolidIndex(block);
  }
}

function collidesWithSolid(size, y, x, z) {
  return solidOverlapInfo(size, y, x, z).penetration > 0;
}

function solidOverlapInfo(size, y, x, z) {
  const radius = playerRadius(size);
  const bodyRadius = radius + 0.5;
  let best = null;
  let bestPenetration = 0;
  let bestPushX = 0;
  let bestPushZ = 0;
  for (const block of blocksNear(solidBlockCells, x, z, bodyRadius)) {
    if (!block.active || !verticalOverlapsPlayer(size, y, block)) continue;
    const dx = x - block.x;
    const dz = z - block.z;
    const overlapX = bodyRadius - Math.abs(dx);
    const overlapZ = bodyRadius - Math.abs(dz);
    if (overlapX <= 0 || overlapZ <= 0) continue;
    const penetration = Math.min(overlapX, overlapZ);
    if (penetration > bestPenetration) {
      best = block;
      bestPenetration = penetration;
      if (overlapX <= overlapZ) {
        bestPushX = dx >= 0 ? 1 : -1;
        bestPushZ = 0;
      } else {
        bestPushX = 0;
        bestPushZ = dz >= 0 ? 1 : -1;
      }
    }
  }
  return { block: best, penetration: bestPenetration, pushX: bestPushX, pushZ: bestPushZ };
}

function supportHeightAt(size, y, x, z) {
  const radius = playerRadius(size);
  let support = 0;
  for (const block of blocksNear(solidBlockCells, x, z, radius + 0.5)) {
    if (!block.active) continue;
    const top = block.y + block.size / 2;
    if (top > y + STEP_TOLERANCE) continue;
    if (Math.abs(x - block.x) <= radius + 0.5 && Math.abs(z - block.z) <= radius + 0.5) {
      support = Math.max(support, top);
    }
  }
  return support;
}

function findSameHeightRecovery(size, y, x, z) {
  const radius = playerRadius(size);
  const half = worldSize / 2;
  const maxStep = Math.max(UNSTUCK_RECOVERY_MAX_STEP, radius * 4 + 8);
  const startX = clamp(x, -half + radius, half - radius);
  const startZ = clamp(z, -half + radius, half - radius);
  if (!collidesWithSolid(size, y, startX, startZ)) return { x: startX, y, z: startZ };

  let best = null;
  let bestDistance = Infinity;
  for (let r = UNSTUCK_OPEN_SCAN_STEP; r <= maxStep; r += UNSTUCK_OPEN_SCAN_STEP) {
    const samples = Math.max(12, Math.ceil(r * 10));
    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2 + r * 0.37;
      const cx = clamp(x + Math.cos(angle) * r, -half + radius, half - radius);
      const cz = clamp(z + Math.sin(angle) * r, -half + radius, half - radius);
      if (collidesWithSolid(size, y, cx, cz)) continue;
      const horizontal = Math.hypot(cx - x, cz - z);
      if (horizontal < bestDistance) {
        bestDistance = horizontal;
        best = { x: cx, y, z: cz };
      }
    }
    if (best) return best;
  }
  return best;
}

function findArenaRecovery(size) {
  const radius = playerRadius(size);
  const half = worldSize / 2;
  const edge = half - radius - UNSTUCK_EDGE_RECOVERY_MARGIN;
  for (let offset = -edge; offset <= edge; offset += UNSTUCK_EDGE_RECOVERY_STEP) {
    const candidates = [
      { x: offset, y: 0, z: -edge },
      { x: edge, y: 0, z: offset },
      { x: offset, y: 0, z: edge },
      { x: -edge, y: 0, z: offset },
    ];
    for (const candidate of candidates) {
      if (!collidesWithSolid(size, candidate.y, candidate.x, candidate.z)) return candidate;
    }
  }

  for (let gx = -edge; gx <= edge; gx += UNSTUCK_EDGE_RECOVERY_STEP * 2) {
    for (let gz = -edge; gz <= edge; gz += UNSTUCK_EDGE_RECOVERY_STEP * 2) {
      if (!collidesWithSolid(size, 0, gx, gz)) return { x: gx, y: 0, z: gz };
    }
  }

  return { x: -edge, y: 0, z: -edge };
}

function hardRecoverLocalPlayer() {
  const recovery = findSameHeightRecovery(localSize, localPos.y, localPos.x, localPos.z) || findArenaRecovery(localSize);
  localPos.x = recovery.x;
  localPos.y = recovery.y;
  localPos.z = recovery.z;
  localVy = 0;
  stuckTimer = 0;
  stuckBestPenetration = Infinity;
}

function resetUnstuckProgress() {
  stuckTimer = 0;
  stuckBestPenetration = Infinity;
}

function canMoveWithOverlap(size, y, x, z, currentPenetration) {
  const candidatePenetration = solidOverlapInfo(size, y, x, z).penetration;
  return candidatePenetration <= 0 || candidatePenetration <= currentPenetration + UNSTUCK_PROGRESS_EPSILON;
}

function rebuildArena(size) {
  worldSize = size;
  ground.geometry.dispose();
  ground.geometry = new THREE.BoxGeometry(worldSize, 0.3, worldSize);

  wallGroup.clear();
  const wallMat = material("#9a2e34");
  const half = worldSize / 2;
  const walls = [
    [0, 3, -half, worldSize, 6, 1],
    [0, 3, half, worldSize, 6, 1],
    [-half, 3, 0, 1, 6, worldSize],
    [half, 3, 0, 1, 6, worldSize],
  ];
  for (const [x, y, z, w, h, d] of walls) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    wall.position.set(x, y, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    wallGroup.add(wall);
  }

  roadLines.clear();
  const lineMat = material("#f4f6f8");
  const roadExtent = Math.floor(half / 20) * 20 - 10;
  for (let i = -roadExtent; i <= roadExtent; i += 20) {
    const lineA = new THREE.Mesh(new THREE.BoxGeometry(10, 0.04, 0.7), lineMat);
    lineA.position.set(i, 0.03, 0);
    roadLines.add(lineA);
    const lineB = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.04, 10), lineMat);
    lineB.position.set(0, 0.035, i);
    roadLines.add(lineB);
  }
}

function makeNameSprite(text) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext("2d");
  drawNameTag(ctx, c, text, 1);
  const texture = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.scale.set(NAME_LABEL_BASE_WIDTH, NAME_LABEL_BASE_HEIGHT, 1);
  sprite.userData.canvas = c;
  sprite.userData.ctx = ctx;
  sprite.userData.texture = texture;
  sprite.userData.name = text;
  sprite.userData.size = "1.0";
  return sprite;
}

function updateNameSprite(sprite, name, size) {
  if (!sprite || (sprite.userData.name === name && sprite.userData.size === size.toFixed(1))) return;
  const ctx = sprite.userData.ctx;
  const c = sprite.userData.canvas;
  drawNameTag(ctx, c, name, size);
  sprite.userData.texture.needsUpdate = true;
  sprite.userData.name = name;
  sprite.userData.size = size.toFixed(1);
}

function drawNameTag(ctx, c, name, size) {
  const sizeText = `size: ${size.toFixed(1)}`;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = "700 30px system-ui";
  const nameWidth = ctx.measureText(name).width;
  ctx.font = "700 22px system-ui";
  const sizeWidth = ctx.measureText(sizeText).width;
  const rectWidth = Math.min(460, Math.max(150, Math.ceil(Math.max(nameWidth, sizeWidth)) + 44));
  const rectHeight = 74;
  const rectX = (c.width - rectWidth) / 2;
  const rectY = 27;

  ctx.fillStyle = "rgba(9, 16, 28, 0.82)";
  roundedRect(ctx, rectX, rectY, rectWidth, rectHeight, 18);
  ctx.fill();
  ctx.fillStyle = "#e9f4ff";
  ctx.font = "700 30px system-ui";
  ctx.fillText(name, c.width / 2, 58, rectWidth - 36);
  ctx.fillStyle = "#c4d7e7";
  ctx.font = "700 22px system-ui";
  ctx.fillText(sizeText, c.width / 2, 86, rectWidth - 36);
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

function createEatingEffect() {
  const positions = new Float32Array(EAT_PARTICLE_COUNT * 3);
  const colors = new Float32Array(EAT_PARTICLE_COUNT * 3);
  const baseColors = new Float32Array(EAT_PARTICLE_COUNT * 3);
  const velocities = new Float32Array(EAT_PARTICLE_COUNT * 3);
  const lives = new Float32Array(EAT_PARTICLE_COUNT);
  for (let i = 0; i < EAT_PARTICLE_COUNT; i++) {
    positions[i * 3 + 1] = -999;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(geometry, eatParticleMaterial);
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);
  return {
    points,
    geometry,
    positions,
    colors,
    baseColors,
    velocities,
    lives,
    cursor: 0,
    spawnAccumulator: 0,
    phase: 0,
  };
}

function spawnEatingParticle(effect, entry, scale) {
  const i = effect.cursor;
  effect.cursor = (effect.cursor + 1) % EAT_PARTICLE_COUNT;
  effect.phase += 2.399963;

  const angle = effect.phase;
  const ring = (0.45 + ((i * 17) % 100) / 180) * scale;
  const px = entry.current.x + Math.cos(angle) * ring;
  const py = entry.current.y + (0.35 + ((i * 23) % 100) / 100 * 1.85) * scale;
  const pz = entry.current.z + Math.sin(angle) * ring;
  const offset = i * 3;
  effect.positions[offset] = px;
  effect.positions[offset + 1] = py;
  effect.positions[offset + 2] = pz;
  effect.velocities[offset] = Math.cos(angle + 0.9) * 0.18 * scale;
  effect.velocities[offset + 1] = (1.2 + ((i * 13) % 100) / 130) * scale;
  effect.velocities[offset + 2] = Math.sin(angle + 0.9) * 0.18 * scale;
  effect.lives[i] = EAT_PARTICLE_LIFETIME;

  const [r, g, b] = hslToRgb((i * 67 + effect.phase * 38) % 360, 0.92, 0.62);
  effect.baseColors[offset] = r;
  effect.baseColors[offset + 1] = g;
  effect.baseColors[offset + 2] = b;
  effect.colors[offset] = r;
  effect.colors[offset + 1] = g;
  effect.colors[offset + 2] = b;
}

function clearEatingEffect(effect) {
  if (!effect) return;
  let changed = false;
  for (let i = 0; i < EAT_PARTICLE_COUNT; i++) {
    if (effect.lives[i] <= 0) continue;
    effect.lives[i] = 0;
    effect.positions[i * 3 + 1] = -999;
    changed = true;
  }
  effect.spawnAccumulator = 0;
  effect.points.visible = false;
  if (changed) effect.geometry.attributes.position.needsUpdate = true;
}

function updateEatingEffect(entry, dt) {
  const effect = entry.eatEffect;
  if (!effect) return;
  const active = Boolean(entry.target.eatenBy) && !entry.target.dead;
  const scale = playerScale(entry.current.size);
  if (active) {
    effect.spawnAccumulator += dt * EAT_PARTICLE_RATE;
    const spawnCount = Math.min(6, Math.floor(effect.spawnAccumulator));
    effect.spawnAccumulator -= spawnCount;
    for (let i = 0; i < spawnCount; i++) spawnEatingParticle(effect, entry, scale);
  } else if (effect.spawnAccumulator !== 0) {
    effect.spawnAccumulator = 0;
  }

  let anyLive = false;
  for (let i = 0; i < EAT_PARTICLE_COUNT; i++) {
    if (effect.lives[i] <= 0) continue;
    effect.lives[i] = Math.max(0, effect.lives[i] - dt);
    const offset = i * 3;
    if (effect.lives[i] <= 0) {
      effect.positions[offset + 1] = -999;
      continue;
    }
    const fade = effect.lives[i] / EAT_PARTICLE_LIFETIME;
    effect.positions[offset] += effect.velocities[offset] * dt;
    effect.positions[offset + 1] += effect.velocities[offset + 1] * dt;
    effect.positions[offset + 2] += effect.velocities[offset + 2] * dt;
    effect.colors[offset] = effect.baseColors[offset] * fade;
    effect.colors[offset + 1] = effect.baseColors[offset + 1] * fade;
    effect.colors[offset + 2] = effect.baseColors[offset + 2] * fade;
    anyLive = true;
  }
  effect.points.visible = anyLive || active;
  effect.geometry.attributes.position.needsUpdate = true;
  effect.geometry.attributes.color.needsUpdate = true;
}

function createPlayerMesh(player) {
  const group = new THREE.Group();
  const bodyMat = material(player.color || "#d85c4a");
  const skinMat = material("#d7a679");
  const pantsMat = material("#203247");
  const hairMat = material("#4b2b1e");

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1, 0.45), bodyMat);
  body.position.y = 1.05;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.65, 0.65), skinMat);
  head.position.y = 1.88;
  const hair = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.22, 0.72), hairMat);
  hair.position.y = 2.25;
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.8, 0.32), pantsMat);
  legL.position.set(-0.22, 0.4, 0);
  const legR = legL.clone();
  legR.position.x = 0.22;
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.85, 0.28), skinMat);
  armL.position.set(-0.62, 1.05, 0);
  const armR = armL.clone();
  armR.position.x = 0.62;
  for (const part of [body, head, hair, legL, legR, armL, armR]) {
    part.castShadow = true;
    part.receiveShadow = true;
    group.add(part);
  }

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1, 40),
    new THREE.MeshBasicMaterial({ color: "#12151a", transparent: true, opacity: 0.22, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.04;

  const label = makeNameSprite(player.name);

  scene.add(group);
  scene.add(shadow);
  scene.add(label);
  return {
    group,
    body,
    legL,
    legR,
    armL,
    armR,
    shadow,
    label,
    eatEffect: createEatingEffect(),
    current: { x: player.x, y: player.y || 0, z: player.z, yaw: player.yaw, size: player.size },
    previous: { x: player.x, y: player.y || 0, z: player.z },
    walkPhase: 0,
    target: player,
  };
}

function upsertPlayer(player) {
  let entry = players.get(player.id);
  if (!entry) {
    entry = createPlayerMesh(player);
    players.set(player.id, entry);
  }
  entry.target = player;
  updateNameSprite(entry.label, player.name, player.size);
}

function removePlayer(id) {
  const entry = players.get(id);
  if (!entry) return;
  scene.remove(entry.group);
  scene.remove(entry.shadow);
  scene.remove(entry.label);
  if (entry.eatEffect) {
    scene.remove(entry.eatEffect.points);
    entry.eatEffect.geometry.dispose();
  }
  players.delete(id);
}

function createBlock(block) {
  if (blocks.has(block.id)) {
    clearPredictedEat(block.id);
    const existing = blocks.get(block.id);
    const blockData = existing.userData.block;
    removeFromSolidIndex(blockData);
    Object.assign(blockData, {
      id: block.id,
      x: block.x,
      y: block.y,
      z: block.z,
      kind: block.kind,
      size: block.size || 1,
      active: block.active,
    });
    existing.position.set(block.x, block.y, block.z);
    existing.visible = block.active;
    existing.userData.kind = block.kind;
    addToSolidIndex(blockData);
    return;
  }
  const blockMat = block.kind === "window" ? windowMaterial : material(block.color || "#aa604b");
  const mesh = new THREE.Mesh(blockGeometry, blockMat);
  mesh.position.set(block.x, block.y, block.z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.visible = block.active;
  mesh.userData.kind = block.kind;
  mesh.userData.baseY = block.y;
  mesh.userData.block = {
    id: block.id,
    x: block.x,
    y: block.y,
    z: block.z,
    kind: block.kind,
    size: block.size || 1,
    active: block.active,
    _solidCellKey: null,
  };
  scene.add(mesh);
  blocks.set(block.id, mesh);
  addToSolidIndex(mesh.userData.block);
}

function setBlockActive(id, active) {
  const mesh = blocks.get(id);
  if (!mesh) return;
  clearPredictedEat(id);
  const block = mesh.userData.block;
  removeFromSolidIndex(block);
  block.active = active;
  mesh.visible = active;
  if (active) {
    mesh.scale.setScalar(0.01);
    mesh.userData.pop = 0;
    addToSolidIndex(block);
  }
}

function handleSnapshot(snapshot) {
  for (const player of snapshot.players) upsertPlayer(player);
  for (const id of [...players.keys()]) {
    if (!snapshot.players.some((p) => p.id === id)) removePlayer(id);
  }
  const self = snapshot.players.find((p) => p.id === selfId);
  if (self) {
    localSize = self.size;
    localDead = Boolean(self.dead);
    if (!localReady) seedLocalPosition(self);
  }
  renderHud(snapshot);
}

function seedLocalPosition(player) {
  localPos = { x: player.x, y: player.y || 0, z: player.z };
  localVy = 0;
  yaw = Number.isFinite(player.yaw) ? player.yaw : yaw;
  localReady = true;
}

function renderHud(snapshot) {
  const self = snapshot.players.find((p) => p.id === selfId);
  if (self) {
    sizeReadout.textContent = `Size: ${self.size.toFixed(1)}u`;
    if (self.dead) {
      eatOverlayText.textContent = "You were eaten!";
      eatCountdown.textContent = "Respawning";
      eatOverlay.classList.remove("hidden");
    } else if (self.eatenBy) {
      eatOverlayText.textContent = "You're being eaten!";
      eatOverlay.classList.remove("hidden");
      eatCountdown.textContent = Math.ceil(self.eatCountdown || 0);
    } else {
      eatOverlay.classList.add("hidden");
    }
  }

  walletReadout.textContent = walletCoins === null ? "" : `Coins: ${walletCoins}`;
  leaderboardList.innerHTML = "";
  for (const item of snapshot.leaderboard || []) {
    const li = document.createElement("li");
    li.innerHTML = `<span>#${item.rank} ${escapeHtml(item.name)}</span><b>${item.size.toFixed(1)}</b>`;
    leaderboardList.appendChild(li);
  }
}

function addActionFeedEntry(eaterName, victimName) {
  if (!actionFeed) return;
  const item = document.createElement("div");
  item.className = "action-feed-entry";
  item.innerHTML = `<b>${escapeHtml(eaterName)}</b> ate <b>${escapeHtml(victimName)}</b>`;
  actionFeed.prepend(item);
  while (actionFeed.children.length > 8) actionFeed.lastElementChild.remove();
  window.setTimeout(() => item.remove(), 8000);
}

function showEatToast(victimName) {
  if (!eatToast) return;
  eatToast.textContent = `You ate ${victimName}!`;
  eatToast.classList.remove("hidden");
  eatToast.style.animation = "none";
  eatToast.offsetHeight;
  eatToast.style.animation = "";
  window.setTimeout(() => eatToast.classList.add("hidden"), 2500);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[ch]));
}

function sendInput() {
  if (!joined || !localReady || localDead) return;
  socket.emit("input", {
    x: localPos.x,
    y: localPos.y,
    z: localPos.z,
    yaw,
    vy: localVy,
    run: isSprintingNow(),
    jump: keys.has("Space"),
  });
}

function inputAxes() {
  return {
    forward: (keys.has("KeyW") ? 1 : 0) + (keys.has("KeyS") ? -1 : 0),
    strafe: (keys.has("KeyA") ? 1 : 0) + (keys.has("KeyD") ? -1 : 0),
  };
}

function isSprintingNow() {
  const axes = inputAxes();
  const moving = axes.forward !== 0 || axes.strafe !== 0;
  return joined && moving && (keys.has("ShiftLeft") || keys.has("ShiftRight")) && !sprintLocked && stamina > 0;
}

function updateStamina(dt, moving) {
  const wantsSprint = moving && (keys.has("ShiftLeft") || keys.has("ShiftRight"));
  if (sprintLocked && stamina >= SPRINT_MIN_CHARGE_TO_START) sprintLocked = false;
  const sprinting = wantsSprint && !sprintLocked && stamina > 0;

  if (sprinting) {
    stamina = Math.max(0, stamina - SPRINT_DRAIN_PER_SECOND * dt);
    if (stamina <= 0) sprintLocked = true;
  } else {
    stamina = Math.min(1, stamina + SPRINT_RECHARGE_PER_SECOND * dt);
    if (sprintLocked && stamina >= SPRINT_MIN_CHARGE_TO_START) sprintLocked = false;
  }

  updateStaminaHud();
  return sprinting;
}

function updateStaminaHud() {
  if (staminaFill) staminaFill.style.width = `${Math.round(stamina * 100)}%`;
  if (staminaBar) staminaBar.classList.toggle("stamina-locked", sprintLocked);
}

function integrateLocalPlayer(dt) {
  if (!joined || !localReady) return;
  if (localDead) {
    localVy = 0;
    resetUnstuckProgress();
    updateStamina(dt, false);
    return;
  }
  let { forward, strafe } = inputAxes();
  const len = Math.hypot(forward, strafe);
  if (len > 1) {
    forward /= len;
    strafe /= len;
  }
  const moving = len > 0;
  const sprinting = updateStamina(dt, moving);
  const speed = moveSpeed(localSize, sprinting);
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const dx = (sin * forward + cos * strafe) * speed * dt;
  const dz = (cos * forward - sin * strafe) * speed * dt;
  const radius = playerRadius(localSize);
  const half = worldSize / 2;
  const nextX = clamp(localPos.x + dx, -half + radius, half - radius);
  const nextZ = clamp(localPos.z + dz, -half + radius, half - radius);

  predictLocalBlockEating(dx, dz, nextX, nextZ);

  let currentPenetration = solidOverlapInfo(localSize, localPos.y, localPos.x, localPos.z).penetration;
  if (canMoveWithOverlap(localSize, localPos.y, nextX, localPos.z, currentPenetration)) localPos.x = nextX;

  currentPenetration = solidOverlapInfo(localSize, localPos.y, localPos.x, localPos.z).penetration;
  if (canMoveWithOverlap(localSize, localPos.y, localPos.x, nextZ, currentPenetration)) localPos.z = nextZ;

  const overlap = solidOverlapInfo(localSize, localPos.y, localPos.x, localPos.z);
  if (overlap.block) {
    const pushStep = UNSTUCK_NUDGE_SPEED * dt;
    const nudgedX = clamp(localPos.x + overlap.pushX * pushStep, -half + radius, half - radius);
    const nudgedZ = clamp(localPos.z + overlap.pushZ * pushStep, -half + radius, half - radius);
    if (canMoveWithOverlap(localSize, localPos.y, nudgedX, nudgedZ, overlap.penetration)) {
      localPos.x = nudgedX;
      localPos.z = nudgedZ;
    } else {
      if (canMoveWithOverlap(localSize, localPos.y, nudgedX, localPos.z, overlap.penetration)) localPos.x = nudgedX;
      const afterNudgeX = solidOverlapInfo(localSize, localPos.y, localPos.x, localPos.z).penetration;
      if (canMoveWithOverlap(localSize, localPos.y, localPos.x, nudgedZ, afterNudgeX)) localPos.z = nudgedZ;
    }
  }

  const finalPenetration = solidOverlapInfo(localSize, localPos.y, localPos.x, localPos.z).penetration;
  if (finalPenetration <= 0) {
    resetUnstuckProgress();
  } else if (finalPenetration < stuckBestPenetration - UNSTUCK_PROGRESS_EPSILON) {
    stuckBestPenetration = finalPenetration;
    stuckTimer = 0;
  } else {
    stuckTimer += dt;
    if (stuckTimer >= UNSTUCK_HARD_RECOVERY_SECONDS) hardRecoverLocalPlayer();
  }

  const supportBefore = supportHeightAt(localSize, localPos.y, localPos.x, localPos.z);
  const grounded = localPos.y <= supportBefore + GROUND_EPSILON && localVy <= 0;
  if (keys.has("Space") && grounded) {
    localPos.y = supportBefore;
    localVy = JUMP_IMPULSE;
  }

  localVy -= GRAVITY * dt;
  localPos.y += localVy * dt;

  const supportAfter = supportHeightAt(localSize, localPos.y, localPos.x, localPos.z);
  if (localPos.y <= supportAfter && localVy <= 0) {
    localPos.y = supportAfter;
    localVy = 0;
  }
  if (localPos.y < 0) {
    localPos.y = 0;
    localVy = 0;
  }
}

function updatePauseUi() {
  const pointerLocked = document.pointerLockElement === canvas;
  if (!joined) {
    pauseMenu?.classList.add("hidden");
    escHint?.classList.add("hidden");
    return;
  }

  if (pointerLocked) {
    clearPointerLockRetry();
    pauseMenu?.classList.add("hidden");
    escHint?.classList.remove("hidden");
    return;
  }

  keys.clear();
  pauseMenu?.classList.remove("hidden");
  escHint?.classList.add("hidden");
}

function clearPointerLockRetry() {
  if (!pointerLockRetryTimer) return;
  window.clearTimeout(pointerLockRetryTimer);
  pointerLockRetryTimer = null;
}

function schedulePointerLockRetry() {
  if (pointerLockRetryTimer) return;
  pointerLockRetryTimer = window.setTimeout(() => {
    pointerLockRetryTimer = null;
    if (!joined || document.pointerLockElement === canvas) return;
    requestGamePointerLock(false);
  }, 400);
}

function requestGamePointerLock(allowRetry = true) {
  if (!joined || document.pointerLockElement === canvas) return;

  try {
    const lockRequest = canvas.requestPointerLock?.();
    if (lockRequest && typeof lockRequest.then === "function") {
      lockRequest.catch(() => {
        if (allowRetry) schedulePointerLockRetry();
      });
    }
  } catch (error) {
    if (allowRetry) schedulePointerLockRetry();
  }
}

async function refreshLobbyStatus() {
  if (joined || startPanel.classList.contains("hidden")) return;
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`Status failed: ${response.status}`);
    const data = await response.json();
    const playersPlaying = Number.isFinite(data.players) ? data.players : 0;
    if (!lobbyStatus || !playButton) return;
    if (playersPlaying > 0) {
      const noun = playersPlaying === 1 ? "player" : "players";
      lobbyStatus.textContent = `Game in progress - ${playersPlaying} ${noun} playing. Jump in!`;
      playButton.textContent = "Join Game";
    } else {
      lobbyStatus.textContent = "No game in progress yet - be the first!";
      playButton.textContent = "Play";
    }
  } catch (error) {
    if (lobbyStatus) lobbyStatus.textContent = "";
    if (playButton) playButton.textContent = "Play";
  }
}

function startLobbyStatusPolling() {
  if (lobbyStatusTimer) return;
  refreshLobbyStatus();
  lobbyStatusTimer = window.setInterval(refreshLobbyStatus, 4000);
}

function stopLobbyStatusPolling() {
  if (!lobbyStatusTimer) return;
  window.clearInterval(lobbyStatusTimer);
  lobbyStatusTimer = null;
}

playButton.addEventListener("click", () => {
  if (joined) return;
  joined = true;
  localReady = false;
  localDead = false;
  localVy = 0;
  resetUnstuckProgress();
  stamina = 1;
  sprintLocked = false;
  keys.clear();
  updateStaminaHud();
  stopLobbyStatusPolling();
  startPanel.classList.add("hidden");
  hud.classList.remove("hidden");
  socket.emit("hello", { glToken: identity.token, name: identity.name || "" });
  requestGamePointerLock();
  updatePauseUi();
});

resumeButton?.addEventListener("click", () => {
  if (!joined) return;
  requestGamePointerLock();
});

exitLobbyButton?.addEventListener("click", () => {
  if (!joined) return;
  socket.emit("leaveGame");
  joined = false;
  selfId = null;
  localReady = false;
  localDead = false;
  localVy = 0;
  resetUnstuckProgress();
  stamina = 1;
  sprintLocked = false;
  keys.clear();
  clearPointerLockRetry();
  document.exitPointerLock?.();
  hud.classList.add("hidden");
  pauseMenu?.classList.add("hidden");
  escHint?.classList.add("hidden");
  eatOverlay.classList.add("hidden");
  if (actionFeed) actionFeed.innerHTML = "";
  eatToast?.classList.add("hidden");
  startPanel.classList.remove("hidden");
  updateStaminaHud();
  startLobbyStatusPolling();
});

document.addEventListener("keydown", (event) => {
  if (event.code === "Space") event.preventDefault();
  keys.add(event.code);
  if (event.code === "Escape") document.exitPointerLock?.();
});

document.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});

document.addEventListener("mousemove", (event) => {
  if (document.pointerLockElement !== canvas) return;
  yaw -= event.movementX * 0.0022;
  pitch = Math.max(-0.35, Math.min(1.35, pitch + event.movementY * 0.0018));
});

canvas.addEventListener("click", () => {
  requestGamePointerLock();
});

document.addEventListener("pointerlockchange", updatePauseUi);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

socket.on("worldInit", (data) => {
  selfId = data.selfId;
  walletCoins = Number.isFinite(data.coins) ? data.coins : null;
  rebuildArena(data.worldSize);
  for (const block of data.blocks) createBlock(block);
  handleSnapshot(data);
});

socket.on("worldSnapshot", handleSnapshot);
socket.on("playerJoined", upsertPlayer);
socket.on("playerLeft", removePlayer);
socket.on("blockConsumed", ({ id }) => setBlockActive(id, false));
socket.on("blockRespawned", (block) => {
  if (!blocks.has(block.id)) createBlock(block);
  setBlockActive(block.id, true);
});
socket.on("playerConsumed", ({ eaterId, eaterName, victimId, victimName }) => {
  addActionFeedEntry(eaterName || "Someone", victimName || "someone");
  if (eaterId === selfId) showEatToast(victimName || "someone");
  const entry = players.get(victimId);
  if (entry) {
    entry.target.dead = true;
    entry.target.eatenBy = null;
    entry.group.position.y = 0.2;
    clearEatingEffect(entry.eatEffect);
  }
  if (victimId === selfId) {
    localDead = true;
    localVy = 0;
    eatOverlayText.textContent = "You were eaten!";
    eatCountdown.textContent = "Respawning";
    eatOverlay.classList.remove("hidden");
  }
});
socket.on("playerReset", (position) => {
  localPos = {
    x: Number(position.x) || 0,
    y: Number(position.y) || 0,
    z: Number(position.z) || 0,
  };
  localVy = 0;
  localDead = false;
  resetUnstuckProgress();
  localReady = true;
  eatOverlay.classList.add("hidden");
});
socket.on("walletUpdate", (coins) => {
  walletCoins = coins;
});

setInterval(sendInput, 1000 / 30);

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameTime) / 1000));
  lastFrameTime = now;
  restoreExpiredPredictedEats(now);
  integrateLocalPlayer(dt);

  const self = players.get(selfId);

  for (const [id, entry] of players) {
    const target = entry.target;
    entry.previous.x = entry.current.x;
    entry.previous.y = entry.current.y;
    entry.previous.z = entry.current.z;
    if (id === selfId && localReady) {
      entry.current.x = localPos.x;
      entry.current.y = localPos.y;
      entry.current.z = localPos.z;
      entry.current.yaw = yaw;
    } else {
      entry.current.x += (target.x - entry.current.x) * 0.35;
      entry.current.y += ((target.y || 0) - entry.current.y) * 0.35;
      entry.current.z += (target.z - entry.current.z) * 0.35;
      entry.current.yaw += normalizeAngle(target.yaw - entry.current.yaw) * 0.35;
    }
    entry.current.size += (target.size - entry.current.size) * 0.18;
    const scale = playerScale(entry.current.size);
    const dead = Boolean(target.dead);
    entry.group.position.set(entry.current.x, entry.current.y, entry.current.z);
    entry.group.rotation.y = entry.current.yaw;
    entry.group.scale.setScalar(scale);
    entry.group.visible = !dead;
    entry.shadow.position.set(entry.current.x, 0.04, entry.current.z);
    entry.shadow.scale.setScalar(target.shadowRadius || 1);
    entry.shadow.visible = !dead;
    const labelScale = clamp(scale * 0.55, NAME_LABEL_MIN_SCALE, NAME_LABEL_MAX_SCALE);
    entry.label.scale.set(NAME_LABEL_BASE_WIDTH * labelScale, NAME_LABEL_BASE_HEIGHT * labelScale, 1);
    entry.label.position.set(entry.current.x, entry.current.y + scale * 2.45 + 0.65 + labelScale * 0.25, entry.current.z);
    entry.label.lookAt(camera.position);
    entry.label.visible = !dead;
    if (id === selfId) entry.shadow.material.opacity = 0.32;
    if (dead) clearEatingEffect(entry.eatEffect);
    else updateEatingEffect(entry, dt);
    animateWalk(entry, dt);
  }

  for (const mesh of blocks.values()) {
    if (mesh.userData.pop !== undefined && mesh.scale.x < 1) {
      const s = Math.min(1, mesh.scale.x + 0.08);
      mesh.scale.setScalar(s);
    }
  }

  if (self) {
    const pos = self.group.position;
    const size = Math.max(1, self.current.size);
    const scale = playerScale(size);
    const distance = 4.1 + Math.sqrt(size) * 1.95;
    const eyeHeight = 0.95 + scale * 2.05;
    const elev = pitch;
    const horiz = distance * Math.cos(elev);
    const vert = distance * Math.sin(elev);
    const eye = new THREE.Vector3(pos.x, Math.max(0.85, pos.y + eyeHeight), pos.z);
    const desiredCamera = new THREE.Vector3(
      eye.x - Math.sin(yaw) * horiz,
      Math.max(0.85, eye.y + vert),
      eye.z - Math.cos(yaw) * horiz
    );
    const minCameraStandoff = Math.max(CAMERA_OCCLUSION_MIN_STANDOFF, scale * 0.65);
    const cameraTarget = resolveCameraOcclusion(eye, desiredCamera, distance, pos, minCameraStandoff);
    if (isFiniteVector3(eye) && isFiniteVector3(desiredCamera) && isFiniteVector3(cameraTarget)) {
      camera.position.lerp(cameraTarget, 0.18);
      camera.lookAt(pos.x, pos.y + eyeHeight * 0.5, pos.z);
    }
  } else {
    camera.position.set(25, 26, 35);
    camera.lookAt(0, 0, 0);
  }

  renderer.render(scene, camera);
}

function resolveCameraOcclusion(eye, desiredCamera, cameraDistance, playerPos, minStandoff = CAMERA_OCCLUSION_MIN_STANDOFF) {
  cameraRayDirection.copy(desiredCamera).sub(eye);
  const rayLength = cameraRayDirection.length();
  if (rayLength <= 0.001) return desiredCamera;
  cameraRayDirection.divideScalar(rayLength);
  cameraRaycaster.set(eye, cameraRayDirection);
  cameraRaycaster.near = 0;
  cameraRaycaster.far = rayLength;

  cameraHitCandidates.length = 0;
  const maxBlockDistance = cameraDistance + 4;
  for (const mesh of blocks.values()) {
    if (!mesh.visible || (mesh.userData.kind !== "building" && mesh.userData.kind !== "window")) continue;
    if (Math.hypot(mesh.position.x - playerPos.x, mesh.position.z - playerPos.z) > maxBlockDistance) continue;
    cameraHitCandidates.push(mesh);
  }
  for (const wall of wallGroup.children) cameraHitCandidates.push(wall);

  const hits = cameraRaycaster.intersectObjects(cameraHitCandidates, false);
  if (hits.length === 0) return desiredCamera;
  if (hits[0].distance <= minStandoff) return desiredCamera;
  const clampedDistance = Math.max(minStandoff, hits[0].distance - 0.4);
  return eye.clone().addScaledVector(cameraRayDirection, clampedDistance);
}

function animateWalk(entry, dt) {
  const dx = entry.current.x - entry.previous.x;
  const dz = entry.current.z - entry.previous.z;
  const speed = Math.hypot(dx, dz) / Math.max(dt, 0.001);
  const amount = clamp(speed / 18, 0, 1);
  if (amount > 0.02) entry.walkPhase += speed * dt * 0.72;

  const swing = Math.sin(entry.walkPhase) * 0.72 * amount;
  const oppositeSwing = Math.sin(entry.walkPhase + Math.PI) * 0.72 * amount;
  const bob = Math.abs(Math.sin(entry.walkPhase * 2)) * 0.055 * amount;
  const settle = 1 - Math.exp(-18 * dt);

  entry.legL.rotation.x += (swing - entry.legL.rotation.x) * settle;
  entry.legR.rotation.x += (oppositeSwing - entry.legR.rotation.x) * settle;
  entry.armL.rotation.x += (oppositeSwing * 0.72 - entry.armL.rotation.x) * settle;
  entry.armR.rotation.x += (swing * 0.72 - entry.armR.rotation.x) * settle;
  entry.body.position.y += (1.05 + bob - entry.body.position.y) * settle;
}

function normalizeAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

rebuildArena(worldSize);
startLobbyStatusPolling();
animate();
})();
