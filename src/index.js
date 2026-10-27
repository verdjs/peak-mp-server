// PEAK multiplayer server on Cloudflare: speaks the Photon protocol the game's built-in Photon
// client already uses, so no Photon account (or its player cap) is involved.
//
//   /ns      name server   - hands out the master address and a token (this Worker)
//   /master  master server - says where a room lives               (this Worker)
//   /game/K  game server   - one Durable Object per room, K = app + version + room name
//
// The page rewrites the game's connection to Photon's name server to <this host>/ns; every
// address after that comes from these responses.
import { MSG, W, parseMessage, opResponse, eventMessage, initResponse } from "./protocol.js";
import { OP, EV, P, ERR } from "./codes.js";
import { num, str, pingResponse, makeToken, readToken, roomKey, roomFromKey } from "./util.js";
import { Room } from "./room.js";
import { Lobbies } from "./lobbies.js";

const SUBPROTOCOL = "GpBinaryV18";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.headers.get("Upgrade") !== "websocket") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (path === "/") return new Response("PEAK multiplayer server (Photon protocol). Connect with the game.\n");
      // lobby list for the page (another origin, so CORS; nothing here needs credentials)
      if (path === "/lobbies" && request.method === "GET") return cors(await lobbies(env).fetch("https://lobbies/list"));
      if (path === "/lobbies/find" && request.method === "GET") {
        const code = (url.searchParams.get("code") || "").slice(0, 24);
        return cors(await lobbies(env).fetch("https://lobbies/find?code=" + encodeURIComponent(code)));
      }
      // Temporary: the page posts its frame stats here (Windows only) so they show up in the Worker's
      // log (wrangler tail). Nothing is stored; the body is capped and written as one log line.
      if (path === "/perf" && request.method === "POST") {
        const body = (await request.text()).slice(0, 3000);
        console.log("[perf] " + body.replace(/[\r\n]+/g, " "));
        return new Response(null, { status: 204, headers: CORS });
      }
      const pub = path.match(/^\/game\/([A-Za-z0-9_-]{1,700})\/public$/);
      if (pub && request.method === "POST" && roomFromKey(pub[1])) {
        return cors(await env.ROOMS.get(env.ROOMS.idFromName(pub[1])).fetch("https://room/public", { method: "POST" }));
      }
      return new Response("Not found\n", { status: 404 });
    }
    if (path === "/" || path === "/ns") return front(request, env, "ns");
    if (path === "/master") return front(request, env, "master");
    const m = path.match(/^\/game\/([A-Za-z0-9_-]{1,700})$/);
    if (m && roomFromKey(m[1])) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(request);
    }
    return new Response("Not found\n", { status: 404 });
  },
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400" };
function cors(res) {
  const h = new Headers(res.headers);
  for (const k in CORS) h.set(k, CORS[k]);
  h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers: h });
}
function lobbies(env) { return env.LOBBIES.get(env.LOBBIES.idFromName("all")); }

function upgrade(request, client) {
  const asked = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((s) => s.trim());
  const headers = asked.includes(SUBPROTOCOL) ? { "Sec-WebSocket-Protocol": SUBPROTOCOL } : {};
  return new Response(null, { status: 101, webSocket: client, headers });
}

function socketSend(ws) { return (u8) => { try { ws.send(u8); } catch (e) {} }; }
function closeBack(ws) { return () => { try { ws.close(1000, "bye"); } catch (e) {} }; }

// ---- name server and master server ------------------------------------------------------------
// Both are short conversations with no shared state, so each connection is handled right here.

function front(request, env, role) {
  const url = new URL(request.url);
  const base = (url.protocol === "https:" ? "wss://" : "ws://") + url.host;
  const [client, ws] = Object.values(new WebSocketPair());
  ws.accept();
  const send = socketSend(ws);
  const conv = { role, base, env, send, token: null, queue: Promise.resolve() };
  send(initResponse());
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") return;
    let m;
    try { m = parseMessage(new Uint8Array(ev.data)); } catch (e) { return; }
    if (m.encrypted) return;
    if (m.type === MSG.InternalOperation) { if (m.op === OP.Ping) send(pingResponse(m.params)); return; }
    if (m.type !== MSG.Operation) return;
    // keep responses in request order even when one has to ask a room first
    conv.queue = conv.queue.then(() => frontOperation(conv, m.op, m.params)).catch((e) => {
      console.log(`${role} op ${m.op} failed: ${e && e.stack || e}`);
      send(opResponse(m.op, ERR.InternalServerError, String(e && e.message || e)));
    });
  });
  ws.addEventListener("close", closeBack(ws));
  ws.addEventListener("error", closeBack(ws));   // client vanished; nothing to clean up
  return upgrade(request, client);
}

async function frontOperation(conv, op, params) {
  const { send, base } = conv;
  if (op === OP.Authenticate || op === OP.AuthOnce) {
    const t = readToken(str(params, P.Token)) || {
      appId: str(params, P.ApplicationId) || "",
      appVersion: str(params, P.AppVersion) || "",
      userId: str(params, P.UserId) || crypto.randomUUID(),
    };
    conv.token = t;
    const token = makeToken(t);
    if (conv.role === "ns") {
      send(opResponse(op, 0, null, [
        [P.Cluster, W.str("default")],
        [P.Address, W.str(base + "/master")],
        [P.Token, W.str(token)],
        [P.UserId, W.str(t.userId)],
      ]));
    } else {
      send(eventMessage(EV.AppStats, [[P.MasterPeerCount, W.int(1)], [P.PeerCount, W.int(0)], [P.GameCount, W.int(0)]]));
      send(opResponse(op, 0, null, [[P.Position, W.int(0)], [P.Token, W.str(token)]]));
    }
    return;
  }
  if (conv.role === "ns") {
    if (op === OP.GetRegions) {
      send(opResponse(op, 0, null, [[P.Region, W.strArray(["au"])], [P.Address, W.strArray([base + "/master"])]]));
      return;
    }
    send(opResponse(op, ERR.InvalidOperation, "not supported by the name server"));
    return;
  }
  // master server
  const t = conv.token;
  if (!t && (op === OP.CreateGame || op === OP.JoinGame)) { send(opResponse(op, ERR.OperationNotAllowedInCurrentState, "authenticate first")); return; }
  switch (op) {
    case OP.JoinLobby: case OP.LeaveLobby:
      send(opResponse(op, 0, null));
      return;
    case OP.CreateGame: {
      const name = str(params, P.RoomName) || crypto.randomUUID();
      const key = roomKey(t, name), info = await roomInfo(conv.env, key);
      if (info.created) { send(opResponse(op, ERR.GameIdAlreadyExists, "A game with the specified id already exist.")); return; }
      send(opResponse(op, 0, null, [[P.Address, W.str(base + "/game/" + key)], [P.RoomName, W.str(name)], [P.Token, W.str(makeToken(t))]]));
      return;
    }
    case OP.JoinGame: {
      const name = str(params, P.RoomName);
      if (!name) { send(opResponse(op, ERR.InvalidOperation, "room name missing")); return; }
      const key = roomKey(t, name), info = await roomInfo(conv.env, key);
      if (!info.created && num(params, P.JoinMode) !== 1) { send(opResponse(op, ERR.GameDoesNotExist, "Game does not exist")); return; }
      if (info.created && !info.open) { send(opResponse(op, ERR.GameClosed, "Game closed")); return; }
      if (info.created && info.max > 0 && info.players >= info.max) { send(opResponse(op, ERR.GameFull, "Game full")); return; }
      send(opResponse(op, 0, null, [[P.Address, W.str(base + "/game/" + key)], [P.Token, W.str(makeToken(t))]]));
      return;
    }
    case OP.JoinRandomGame:
      send(opResponse(op, ERR.NoRandomMatchFound, "No match found"));
      return;
    default:
      send(opResponse(op, ERR.InvalidOperation, "not supported by the master server"));
  }
}

async function roomInfo(env, key) {
  const res = await env.ROOMS.get(env.ROOMS.idFromName(key)).fetch("https://room/info");
  return res.json();
}

// ---- game server ----------------------------------------------------------------------------

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.timer = null;
    this.key = "";
    this.public = false;
    this.reported = "";     // last summary sent to the lobby list
    this.reportAt = 0;
    this.reportTimer = null;
  }

  // Tells the lobby list about this room: a second after something changed, and every 30 s
  // while it exists (so the list can drop rooms whose server went away). Never awaited by
  // the game traffic.
  report(soon) {
    if (this.reportTimer || !this.key) return;
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null;
      const r = this.room, k = roomFromKey(this.key);
      if (!r || !k) return;
      if (!r.created) this.public = false;
      const s = { ...r.summary(), code: k.name, ver: k.appVersion, pub: this.public };
      const json = JSON.stringify(s), now = Date.now();
      if (json === this.reported && now - this.reportAt < 30000) return;
      this.reported = json; this.reportAt = now;
      const body = JSON.stringify({ key: this.key, s });
      lobbies(this.env).fetch(r.created ? "https://lobbies/put" : "https://lobbies/del", { method: "POST", body })
        .catch((e) => console.log("lobby report failed: " + e));
    }, soon ? 1000 : 0);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/info") return Response.json(this.room ? this.room.info() : { created: false, open: true, players: 0, max: 0 });
    if (url.pathname === "/public") {
      if (!this.room || !this.room.created) return Response.json({ ok: false }, { status: 404 });
      this.public = true; this.report(true);
      return Response.json({ ok: true });
    }
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket\n", { status: 426 });
    if (!this.room) {
      this.key = url.pathname.split("/")[2] || "";
      const r = roomFromKey(this.key);
      this.room = new Room(r ? JSON.stringify(r.name) : "?", (s) => console.log(s));
    }
    const [client, ws] = Object.values(new WebSocketPair());
    ws.accept();
    const conn = { send: socketSend(ws), close: (code, reason) => { try { ws.close(code, reason); } catch (e) {} }, userId: "" };
    this.room.connect(conn);
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") this.room.message(conn, new Uint8Array(ev.data));
      this.report(true);
    });
    const gone = () => { this.room.disconnect(conn); try { ws.close(1000, "bye"); } catch (e) {} this.report(true); };
    ws.addEventListener("close", gone);
    ws.addEventListener("error", gone);
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.room.sweep(Date.now());
        this.report(true);
        if (!this.room.conns.size) { clearInterval(this.timer); this.timer = null; }
      }, 5000);
    }
    return upgrade(request, client);
  }
}

// ---- lobby list ---------------------------------------------------------------------------
// One instance ("all"). Rooms post their summaries; the Worker asks for the list or a code.

export class LobbyList {
  constructor(ctx, env) { this.lobbies = new Lobbies(); }

  async fetch(request) {
    const url = new URL(request.url), now = Date.now();
    if (request.method === "POST" && (url.pathname === "/put" || url.pathname === "/del")) {
      let j = null;
      try { j = await request.json(); } catch (e) {}
      if (j && url.pathname === "/put") this.lobbies.put(j.key, j.s, now);
      else if (j) this.lobbies.del(j.key);
      return new Response("ok");
    }
    if (url.pathname === "/list") return Response.json({ lobbies: this.lobbies.list(now) });
    if (url.pathname === "/find") return Response.json(this.lobbies.find(url.searchParams.get("code") || "", now));
    return new Response("Not found\n", { status: 404 });
  }
}
