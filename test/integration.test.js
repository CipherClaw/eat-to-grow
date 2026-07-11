"use strict";

const assert = require("node:assert/strict");
const { io: socketClient } = require("socket.io-client");
const game = require("../server.js");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEvent(emitter, event, timeoutMs = 2000, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    function onEvent(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.off(event, onEvent);
      resolve(payload);
    }

    emitter.on(event, onEvent);
  });
}

async function waitForStatus(baseUrl, expectedPlayers, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/status`, { cache: "no-store" });
    assert.equal(response.status, 200);
    lastStatus = await response.json();
    if (lastStatus.players === expectedPlayers) return lastStatus;
    await wait(25);
  }
  throw new Error(`Expected ${expectedPlayers} players, last status was ${JSON.stringify(lastStatus)}`);
}

async function testReconnectRejoin(baseUrl) {
  const client = socketClient(baseUrl, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 250,
    reconnectionDelayMax: 250,
    timeout: 1000,
    forceNew: true,
  });
  const worldInits = [];

  client.on("worldInit", (data) => {
    worldInits.push(data);
  });
  client.io.on("reconnect", () => {
    client.emit("hello", { glToken: null, name: "Reconnect Test" });
  });

  try {
    await waitForEvent(client, "connect");
    client.emit("hello", { glToken: null, name: "Reconnect Test" });
    const firstWorld = await waitForEvent(client, "worldInit");
    assert.ok(firstWorld.selfId);
    await waitForStatus(baseUrl, 1);

    const reconnectPromise = waitForEvent(client.io, "reconnect");
    client.io.engine.close();
    await waitForStatus(baseUrl, 0);
    await reconnectPromise;

    const secondWorld = worldInits.length >= 2
      ? worldInits[worldInits.length - 1]
      : await waitForEvent(client, "worldInit");
    assert.ok(secondWorld.selfId);
    assert.notEqual(secondWorld.selfId, firstWorld.selfId);
    await waitForStatus(baseUrl, 1);
    console.log("integration: reconnect rejoin restored player with new selfId");
  } finally {
    client.close();
    await waitForStatus(baseUrl, 0);
  }
}

function testBuildingRespawnProximityGuard() {
  const buildingId = 999001;
  const playerId = "respawn-proximity-test";
  const player = {
    id: playerId,
    x: 3.1,
    z: 0,
    size: 10,
    dead: false,
  };
  const block = {
    id: 999002,
    x: 3.4,
    z: 0,
    buildingId,
  };

  game._test.buildingFootprints.set(buildingId, {
    cx: 0,
    cz: 0,
    halfW: 1,
    halfD: 1,
    disturbedUntil: 0,
  });
  game._test.players.set(playerId, player);

  try {
    assert.equal(game._test.blockRespawnBlocked(block, new Set(), Date.now()), true);
    console.log("integration: building respawn proximity guard blocks nearby player");
  } finally {
    game._test.players.delete(playerId);
    game._test.buildingFootprints.delete(buildingId);
  }
}

async function main() {
  await new Promise((resolve) => {
    game.startGameServer(0, "127.0.0.1", resolve);
  });
  const address = game.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await testReconnectRejoin(baseUrl);
    testBuildingRespawnProximityGuard();
    console.log("integration: ok");
  } finally {
    await new Promise((resolve) => game.stopGameServer(resolve));
  }
}

main().catch(async (error) => {
  console.error(error);
  await new Promise((resolve) => game.stopGameServer(resolve));
  process.exitCode = 1;
});
