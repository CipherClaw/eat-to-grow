"use strict";
// Server-to-server client for the greglab-games profile hub (https://games.greglab.net).
// Holds the shared PROFILE_API_KEY; never exposed to browser clients.
async function call(baseUrl, apiKey, method, path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || ("hub_" + res.status));
      e.status = res.status;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function createHub(baseUrl, apiKey, gameId, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  return {
    async resolve(token) {
      if (!token) return null;
      try {
        const { profile } = await call(baseUrl, apiKey, "POST", "/api/profile/resolve", { token }, timeoutMs);
        return profile;
      } catch (err) {
        console.warn("[hub] resolve failed:", err.message);
        return null;
      }
    },
    async report(playerId, deltas) {
      try {
        const { result } = await call(baseUrl, apiKey, "POST", "/api/games/" + encodeURIComponent(gameId) + "/report", Object.assign({ playerId }, deltas), timeoutMs);
        return result;
      } catch (err) {
        console.warn("[hub] report failed:", err.message);
        return null;
      }
    }
  };
}

module.exports = {
  fromEnv(gameId) {
    const baseUrl = process.env.PROFILE_API_URL;
    const apiKey = process.env.PROFILE_API_KEY;
    if (!baseUrl || !apiKey) {
      console.log("[hub] PROFILE_API_URL/PROFILE_API_KEY not set; cross-game profile disabled.");
      return null;
    }
    console.log("[hub] cross-game profile enabled via " + baseUrl);
    return createHub(baseUrl.replace(/\/+$/, ""), apiKey, gameId);
  }
};
