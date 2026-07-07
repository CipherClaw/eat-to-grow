/*
 * greglab-client.js — drop-in browser helper for a game served on *.greglab.net.
 *
 * Reads the shared anonymous identity that games.greglab.net set on the parent
 * domain (.greglab.net cookie `gl_player`), so a game can forward the token to
 * its own server. The game server then resolves the token against the hub.
 *
 * Usage (vanilla):
 *   const profile = GreglabGames.getIdentity();
 *   socket.emit("hello", { glToken: profile.token, name: profile.name });
 *
 * If the cookie is missing (e.g. the player came straight to the game without
 * visiting the hub first), `token` is null — the game should fall back to its
 * own guest flow, and optionally link players to the hub.
 *
 * No build step, no dependencies. Safe to copy into any game's static assets.
 */
(function (global) {
  "use strict";

  var PLAYER_COOKIE = "gl_player";
  var NAME_COOKIE = "gl_name";
  var HUB_URL = "https://games.greglab.net";

  function readCookie(name) {
    var match = ("; " + document.cookie).split("; " + name + "=");
    if (match.length === 2) return decodeURIComponent(match.pop().split(";").shift());
    return null;
  }

  function readParam(name) {
    try {
      return new URLSearchParams(global.location.search).get(name);
    } catch (_e) {
      return null;
    }
  }

  // Identity = cookie token (preferred) or ?gl=<token> URL fallback (e.g. when a
  // game is launched cross-origin). The URL fallback is also persisted to a
  // first-party cookie so reloads keep working.
  function getIdentity() {
    var token = readCookie(PLAYER_COOKIE);
    var name = readCookie(NAME_COOKIE);
    if (!token) {
      var fromUrl = readParam("gl");
      if (fromUrl) {
        token = fromUrl;
        // Persist first-party so the token survives navigation within this game.
        document.cookie = PLAYER_COOKIE + "=" + encodeURIComponent(fromUrl) + "; path=/; max-age=31536000; SameSite=Lax";
      }
    }
    return { token: token || null, name: name || null, hubUrl: HUB_URL };
  }

  // Convenience: send the player back to the hub lobby.
  function lobbyUrl() {
    return HUB_URL;
  }

  global.GreglabGames = {
    getIdentity: getIdentity,
    lobbyUrl: lobbyUrl,
    PLAYER_COOKIE: PLAYER_COOKIE,
    NAME_COOKIE: NAME_COOKIE,
  };
})(typeof window !== "undefined" ? window : this);
