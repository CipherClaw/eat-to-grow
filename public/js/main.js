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

const keys = new Set();
const blocks = new Map();
const players = new Map();
let lobbyStatusTimer = null;

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

function material(color) {
  if (!materialCache.has(color)) {
    materialCache.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.82 }));
  }
  return materialCache.get(color);
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
  ctx.fillStyle = "rgba(9, 16, 28, 0.82)";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#e9f4ff";
  ctx.font = "700 40px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(text, c.width / 2, 52);
  ctx.fillStyle = "#c4d7e7";
  ctx.font = "700 28px system-ui";
  ctx.fillText("size: 1.0", c.width / 2, 94);
  const texture = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.scale.set(4.8, 1.2, 1);
  sprite.userData.canvas = c;
  sprite.userData.ctx = ctx;
  sprite.userData.texture = texture;
  sprite.userData.name = text;
  return sprite;
}

function updateNameSprite(sprite, name, size) {
  if (!sprite || sprite.userData.name === name && sprite.userData.size === size.toFixed(1)) return;
  const ctx = sprite.userData.ctx;
  const c = sprite.userData.canvas;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = "rgba(9, 16, 28, 0.82)";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#e9f4ff";
  ctx.font = "700 40px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(name, c.width / 2, 52);
  ctx.fillStyle = "#c4d7e7";
  ctx.font = "700 28px system-ui";
  ctx.fillText(`size: ${size.toFixed(1)}`, c.width / 2, 94);
  sprite.userData.texture.needsUpdate = true;
  sprite.userData.name = name;
  sprite.userData.size = size.toFixed(1);
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
  group.add(label);

  scene.add(group);
  scene.add(shadow);
  return {
    group,
    shadow,
    label,
    current: { x: player.x, y: player.y || 0, z: player.z, yaw: player.yaw, size: player.size },
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
  players.delete(id);
}

function createBlock(block) {
  const blockMat = block.kind === "window" ? windowMaterial : material(block.color || "#aa604b");
  const mesh = new THREE.Mesh(blockGeometry, blockMat);
  mesh.position.set(block.x, block.y, block.z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.visible = block.active;
  mesh.userData.baseY = block.y;
  scene.add(mesh);
  blocks.set(block.id, mesh);
}

function setBlockActive(id, active) {
  const mesh = blocks.get(id);
  if (!mesh) return;
  mesh.visible = active;
  if (active) {
    mesh.scale.setScalar(0.01);
    mesh.userData.pop = 0;
  }
}

function handleSnapshot(snapshot) {
  for (const player of snapshot.players) upsertPlayer(player);
  for (const id of [...players.keys()]) {
    if (!snapshot.players.some((p) => p.id === id)) removePlayer(id);
  }
  renderHud(snapshot);
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
  if (!joined) return;
  const forward = (keys.has("KeyW") ? 1 : 0) + (keys.has("KeyS") ? -1 : 0);
  const strafe = (keys.has("KeyA") ? 1 : 0) + (keys.has("KeyD") ? -1 : 0);
  socket.emit("input", {
    forward,
    strafe,
    yaw,
    run: keys.has("ShiftLeft") || keys.has("ShiftRight"),
    jump: keys.has("Space"),
  });
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
  window.location.href = lobbyUrl;
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
socket.on("walletUpdate", (coins) => {
  walletCoins = coins;
});

setInterval(sendInput, 1000 / 30);

function animate() {
  requestAnimationFrame(animate);
  const self = players.get(selfId);

  for (const [id, entry] of players) {
    const target = entry.target;
    entry.current.x += (target.x - entry.current.x) * 0.28;
    entry.current.y += ((target.y || 0) - entry.current.y) * 0.28;
    entry.current.z += (target.z - entry.current.z) * 0.28;
    entry.current.yaw += normalizeAngle(target.yaw - entry.current.yaw) * 0.28;
    entry.current.size += (target.size - entry.current.size) * 0.18;
    const scale = Math.max(0.45, Math.pow(entry.current.size, 0.45));
    entry.group.position.set(entry.current.x, entry.current.y, entry.current.z);
    entry.group.rotation.y = entry.current.yaw;
    entry.group.scale.setScalar(scale);
    entry.shadow.position.set(entry.current.x, 0.04, entry.current.z);
    entry.shadow.scale.setScalar(target.shadowRadius || 1);
    entry.label.position.set(0, 2.85, 0);
    entry.label.lookAt(camera.position);
    if (id === selfId) entry.shadow.material.opacity = 0.32;
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
    const distance = 8 + Math.sqrt(size) * 4.4;
    const eyeHeight = 1.5 + Math.sqrt(size) * 1.5;
    const elev = pitch;
    const horiz = distance * Math.cos(elev);
    const vert = distance * Math.sin(elev);
    const cameraTarget = new THREE.Vector3(
      pos.x - Math.sin(yaw) * horiz,
      Math.max(0.85, pos.y + eyeHeight + vert),
      pos.z - Math.cos(yaw) * horiz
    );
    camera.position.lerp(cameraTarget, 0.18);
    camera.lookAt(pos.x, pos.y + eyeHeight * 0.5, pos.z);
  } else {
    camera.position.set(25, 26, 35);
    camera.lookAt(0, 0, 0);
  }

  renderer.render(scene, camera);
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
