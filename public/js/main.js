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
const eatCountdown = document.getElementById("eatCountdown");
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
let lastFrameTime = performance.now();
let stamina = 1;
let sprintLocked = false;

const keys = new Set();
const blocks = new Map();
const solidBlockCells = new Map();
const players = new Map();
let lobbyStatusTimer = null;
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

function material(color) {
  if (!materialCache.has(color)) {
    materialCache.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.82 }));
  }
  return materialCache.get(color);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function collidesWithSolid(size, y, x, z) {
  const radius = playerRadius(size);
  const bodyRadius = radius + 0.5;
  for (const block of blocksNear(solidBlockCells, x, z, bodyRadius)) {
    if (!block.active || !verticalOverlapsPlayer(size, y, block)) continue;
    if (Math.abs(x - block.x) < bodyRadius && Math.abs(z - block.z) < bodyRadius) return true;
  }
  return false;
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
  sprite.scale.set(2.6, 0.65, 1);
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
  players.delete(id);
}

function createBlock(block) {
  if (blocks.has(block.id)) {
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
    if (self.eatenBy) {
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
  if (!joined || !localReady) return;
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

  if (!collidesWithSolid(localSize, localPos.y, nextX, localPos.z)) localPos.x = nextX;
  if (!collidesWithSolid(localSize, localPos.y, localPos.x, nextZ)) localPos.z = nextZ;

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
    pauseMenu?.classList.add("hidden");
    escHint?.classList.remove("hidden");
    return;
  }

  keys.clear();
  pauseMenu?.classList.remove("hidden");
  escHint?.classList.add("hidden");
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
  localVy = 0;
  stamina = 1;
  sprintLocked = false;
  keys.clear();
  updateStaminaHud();
  stopLobbyStatusPolling();
  startPanel.classList.add("hidden");
  hud.classList.remove("hidden");
  socket.emit("hello", { glToken: identity.token, name: identity.name || "" });
  canvas.requestPointerLock?.();
  updatePauseUi();
});

resumeButton?.addEventListener("click", () => {
  if (!joined) return;
  canvas.requestPointerLock?.();
});

exitLobbyButton?.addEventListener("click", () => {
  if (!joined) return;
  socket.emit("leaveGame");
  joined = false;
  selfId = null;
  localReady = false;
  localVy = 0;
  stamina = 1;
  sprintLocked = false;
  keys.clear();
  document.exitPointerLock?.();
  hud.classList.add("hidden");
  pauseMenu?.classList.add("hidden");
  escHint?.classList.add("hidden");
  eatOverlay.classList.add("hidden");
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
  if (joined) canvas.requestPointerLock?.();
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
socket.on("playerConsumed", ({ victimId }) => {
  const entry = players.get(victimId);
  if (entry) entry.group.position.y = 0.2;
});
socket.on("playerReset", (position) => {
  localPos = {
    x: Number(position.x) || 0,
    y: Number(position.y) || 0,
    z: Number(position.z) || 0,
  };
  localVy = 0;
  localReady = true;
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
    entry.group.position.set(entry.current.x, entry.current.y, entry.current.z);
    entry.group.rotation.y = entry.current.yaw;
    entry.group.scale.setScalar(scale);
    entry.shadow.position.set(entry.current.x, 0.04, entry.current.z);
    entry.shadow.scale.setScalar(target.shadowRadius || 1);
    entry.label.position.set(entry.current.x, entry.current.y + scale * 2.45 + 0.55, entry.current.z);
    entry.label.lookAt(camera.position);
    if (id === selfId) entry.shadow.material.opacity = 0.32;
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
    const cameraTarget = resolveCameraOcclusion(eye, desiredCamera, distance, pos);
    camera.position.lerp(cameraTarget, 0.18);
    camera.lookAt(pos.x, pos.y + eyeHeight * 0.5, pos.z);
  } else {
    camera.position.set(25, 26, 35);
    camera.lookAt(0, 0, 0);
  }

  renderer.render(scene, camera);
}

function resolveCameraOcclusion(eye, desiredCamera, cameraDistance, playerPos) {
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
  const clampedDistance = Math.max(1.2, hits[0].distance - 0.4);
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
