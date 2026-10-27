// The game-server half of Photon LoadBalancing: one Room holds the actors, properties and
// event cache of one game. It knows nothing about Cloudflare; a connection is any object with
// send(Uint8Array) and close(code, reason), so the same code runs in tests.
//
// Behaviour follows what the real Photon cloud sent the game (see test/capture-photon-1.json):
// the shape of every response and event, who receives what, and which operations get no
// response at all (RaiseEvent, unless it removes cached events).
import { T, W, MSG, PTable, parseMessage, opResponse, eventMessage, initResponse, decodeRaw, sameValue, hex } from "./protocol.js";
import { OP, EV, P, GP, AP, FLAG, CACHE, RECEIVERS, ERR } from "./codes.js";
import { enc, num, bool, str, ints, pingResponse, readToken } from "./util.js";

export const IDLE_TIMEOUT_MS = 20000;      // Photon clients ping every second
const CACHE_MAX_EVENTS = 50000, CACHE_MAX_BYTES = 32 << 20;

// Keys keep their type class: byte 7 and int 7 are different Hashtable keys in .NET.
function keyId(kt, k, kr) {
  if (kt === T.String) return "s" + k;
  if (kt === T.Byte || kt === T.ByteZero) return "b" + k;
  if (typeof k === "number") return "i" + k;
  return "x" + hex(kr);
}
function sameKey(a, b) { return keyId(a.kt, a.k, a.kr) === keyId(b.kt, b.k, b.kr); }

// A property table that keeps keys and values as the exact bytes the client sent.
class Props {
  constructor() { this.m = new Map(); }
  get size() { return this.m.size; }
  set(e) {
    this.m.set(keyId(e.kt, e.k, e.kr), { k: e.k, v: e.v, kt: e.kt, vt: e.vt, kr: e.kr.slice(), vr: e.vr.slice() });
  }
  delete(e) { this.m.delete(keyId(e.kt, e.k, e.kr)); }
  get(e) { return this.m.get(keyId(e.kt, e.k, e.kr)); }
  // server-made byte-keyed entries
  setByte(key, valueWriter) {
    const vr = enc(valueWriter), r = decodeRaw(vr);
    this.m.set("b" + key, { k: key, v: r, kt: T.Byte, vt: vr[0], kr: enc(W.byte(key)), vr });
  }
  getByte(key) { return this.m.get("b" + key); }
  writer() { return W.hash([...this.m.values()].map((e) => [W.raw(e.kr), W.raw(e.vr)])); }
}

export class Room {
  constructor(name = "", log = () => {}) {
    this.name = name;
    this.log = log;
    this.conns = new Set();
    this.reset();
  }

  reset() {
    this.created = false;
    this.actors = new Map();      // actorNr -> actor
    this.nextActor = 1;
    this.master = 0;
    this.props = new Props();
    this.flags = 0;
    this.maxPlayers = 0;
    this.isOpen = true;
    this.cache = [];              // { sender, code, raw, global, data? }
    this.cacheBytes = 0;
  }

  info() { return { created: this.created, open: this.isOpen, players: this.actors.size, max: this.maxPlayers }; }

  // What the lobby list needs. The game keeps the loaded scene in the room property "curScn"
  // (Airport while everyone is still in the lobby); any other scene means the climb started.
  summary() {
    const scene = this.props.m.get("scurScn"), master = this.actors.get(this.master);
    const name = master && master.props.getByte(AP.PlayerName);
    return {
      created: this.created, open: this.isOpen, players: this.actors.size, max: this.maxPlayers,
      started: !!scene && typeof scene.v === "string" && scene.v !== "Airport",
      host: name && typeof name.v === "string" ? name.v : "",
    };
  }
  actorList() { return [...this.actors.keys()]; }

  // ---- connections ------------------------------------------------------------------------

  connect(conn) {
    conn.actor = null;
    conn.last = Date.now();
    this.conns.add(conn);
    conn.send(initResponse());
  }

  disconnect(conn) {
    if (!this.conns.delete(conn)) return;
    if (conn.actor) this.leave(conn.actor);
  }

  // Drops connections that went quiet (a crashed or frozen client never closes its socket).
  sweep(now) {
    for (const c of [...this.conns]) {
      if (now - c.last > IDLE_TIMEOUT_MS) {
        this.log(`timeout ${c.actor ? "actor " + c.actor.nr : "connection"} in ${this.name}`);
        c.close(4000, "timeout");
        this.disconnect(c);
      }
    }
  }

  message(conn, u8) {
    conn.last = Date.now();
    let m;
    try { m = parseMessage(u8); } catch (e) { this.log("bad message: " + e.message); return; }
    if (m.encrypted) return;
    if (m.type === MSG.InternalOperation) {
      if (m.op === OP.Ping) conn.send(pingResponse(m.params));
      else conn.send(opResponse(m.op, ERR.InvalidOperation, "not supported", [], true));
      return;
    }
    if (m.type !== MSG.Operation) return;
    try { this.operation(conn, m.op, m.params); }
    catch (e) {
      this.log(`op ${m.op} failed: ${e && e.stack || e}`);
      conn.send(opResponse(m.op, ERR.InternalServerError, String(e && e.message || e)));
    }
  }

  operation(conn, op, params) {
    switch (op) {
      case OP.Authenticate: case OP.AuthOnce: {
        const t = readToken(str(params, P.Token));
        conn.userId = (t && t.userId) || str(params, P.UserId) || conn.userId || "";
        conn.send(opResponse(op, 0, null));
        return;
      }
      case OP.CreateGame: return this.create(conn, params, op);
      case OP.JoinGame: return this.join(conn, params);
      case OP.Leave:
        conn.send(opResponse(op, 0, null));
        if (conn.actor) this.leave(conn.actor);
        return;
    }
    if (!conn.actor) { conn.send(opResponse(op, ERR.OperationNotAllowedInCurrentState, "not in a room")); return; }
    switch (op) {
      case OP.RaiseEvent: return this.raiseEvent(conn.actor, params);
      case OP.SetProperties: return this.setProperties(conn.actor, params);
      case OP.GetProperties: return this.getProperties(conn.actor, params);
      case OP.ChangeGroups: return this.changeGroups(conn.actor, params);
      default: conn.send(opResponse(op, ERR.InvalidOperation, "operation " + op + " not supported"));
    }
  }

  // ---- joining ----------------------------------------------------------------------------

  create(conn, params, op) {
    if (conn.actor) { conn.send(opResponse(op, ERR.OperationNotAllowedInCurrentState, "already in a room")); return; }
    if (this.created) { conn.send(opResponse(op, ERR.GameIdAlreadyExists, "A game with the specified id already exist.")); return; }
    this.setup(params);
    const a = this.addActor(conn, params);
    this.log(`created ${this.name} by actor ${a.nr} (${a.userId})`);
    conn.send(opResponse(op, 0, null, [
      [P.ActorNr, W.int(a.nr)],
      [P.GameProperties, this.props.writer()],
      [P.ActorList, W.intArray(this.actorList())],
      [P.RoomOptionFlags, W.int(this.flags)],
    ]));
    this.announceJoin(a);
  }

  join(conn, params) {
    const op = OP.JoinGame;
    if (conn.actor) { conn.send(opResponse(op, ERR.OperationNotAllowedInCurrentState, "already in a room")); return; }
    const mode = num(params, P.JoinMode) || 0;       // 1 create if missing, 2 join or rejoin, 3 rejoin only
    if (!this.created) {
      if (mode === 1) return this.create(conn, params, op);
      conn.send(opResponse(op, ERR.GameDoesNotExist, "Game does not exist"));
      return;
    }
    if (mode === 3) { conn.send(opResponse(op, ERR.JoinFailedWithRejoinerNotFound, "No inactive actor to rejoin")); return; }
    if (!this.isOpen) { conn.send(opResponse(op, ERR.GameClosed, "Game closed")); return; }
    if (this.maxPlayers > 0 && this.actors.size >= this.maxPlayers) { conn.send(opResponse(op, ERR.GameFull, "Game full")); return; }
    if (this.flags & FLAG.CheckUserOnJoin && conn.userId && [...this.actors.values()].some((x) => x.userId === conn.userId)) {
      conn.send(opResponse(op, ERR.JoinFailedFoundActiveJoiner, "This user is already in the room"));
      return;
    }
    const a = this.addActor(conn, params);
    this.log(`actor ${a.nr} (${a.userId}) joined ${this.name}, ${this.actors.size} in room`);
    const others = [...this.actors.values()].filter((x) => x !== a);
    conn.send(opResponse(op, 0, null, [
      [P.ActorNr, W.int(a.nr)],
      others.length ? [P.PlayerProperties, W.hash(others.map((o) => [W.int(o.nr), o.props.writer()]))] : null,
      [P.GameProperties, this.props.writer()],
      [P.ActorList, W.intArray(this.actorList())],
      [P.RoomOptionFlags, W.int(this.flags)],
    ]));
    this.announceJoin(a);
  }

  setup(params) {
    this.reset();
    this.created = true;
    let flags = num(params, P.RoomOptionFlags);
    if (flags === undefined) {
      flags = (bool(params, P.CleanupCacheOnLeave) !== false ? FLAG.DeleteCacheOnLeave : 0) |
              (bool(params, P.CheckUserOnJoin) ? FLAG.CheckUserOnJoin : 0) |
              (bool(params, P.PublishUserId) ? FLAG.PublishUserId : 0);
    }
    this.flags = flags;
    const gp = params.get(P.GameProperties);
    const table = gp && gp.type === T.Hashtable ? decodeRaw(gp.raw) : null;
    if (table instanceof PTable) for (const e of table.entries) this.props.set(e);
    this.applyRoomProps();
    if (!this.props.getByte(GP.IsOpen)) this.props.setByte(GP.IsOpen, W.bool(true));
    if (!this.props.getByte(GP.IsVisible)) this.props.setByte(GP.IsVisible, W.bool(true));
    if (!this.props.getByte(GP.PropsListedInLobby)) this.props.setByte(GP.PropsListedInLobby, W.strArray([]));
    this.props.setByte(GP.PlayerTtl, W.int(num(params, P.PlayerTTL) || 0));
    this.props.setByte(GP.EmptyRoomTtl, W.int(num(params, P.EmptyRoomTTL) || 0));
  }

  // Reads the room properties the server acts on.
  applyRoomProps() {
    const v = (k) => { const e = this.props.getByte(k); return e ? e.v : undefined; };
    this.isOpen = v(GP.IsOpen) !== false;
    const mp = typeof v(GP.MaxPlayersInt) === "number" ? v(GP.MaxPlayersInt) : v(GP.MaxPlayers);
    this.maxPlayers = typeof mp === "number" && mp > 0 ? mp : 0;
  }

  addActor(conn, params) {
    const nr = this.nextActor++;
    const props = new Props();
    if (this.flags & FLAG.PublishUserId && conn.userId) props.setByte(AP.UserId, W.str(conn.userId));
    const pp = params.get(P.PlayerProperties);
    const table = pp && pp.type === T.Hashtable ? decodeRaw(pp.raw) : null;
    if (table instanceof PTable) for (const e of table.entries) if (!(e.kt === T.Byte && e.k === AP.UserId)) props.set(e);
    const a = { nr, conn, userId: conn.userId || "", props, groups: new Set(), allGroups: false };
    this.actors.set(nr, a);
    conn.actor = a;
    if (!this.master) this.setMaster(nr);
    return a;
  }

  setMaster(nr) {
    this.master = nr;
    if (nr) this.props.setByte(GP.MasterClientId, W.int(nr));
  }

  announceJoin(a) {
    if (!(this.flags & FLAG.SuppressRoomEvents)) {
      this.broadcast(eventMessage(EV.Join, [
        [P.PlayerProperties, a.props.writer()],
        [P.ActorList, W.intArray(this.actorList())],
        [P.ActorNr, W.int(a.nr)],
      ]), this.actors.values());
    }
    for (const e of this.cache) a.conn.send(this.eventFrame(e.code, e.raw, e.sender));
  }

  leave(a) {
    if (this.actors.get(a.nr) !== a) return;
    this.actors.delete(a.nr);
    a.conn.actor = null;
    if (this.flags & FLAG.DeleteCacheOnLeave) this.dropCached((e) => !e.global && e.sender === a.nr);
    let newMaster = 0;
    if (this.master === a.nr) { newMaster = this.actors.size ? Math.min(...this.actors.keys()) : 0; this.setMaster(newMaster); }
    this.log(`actor ${a.nr} left ${this.name}, ${this.actors.size} in room` + (newMaster ? `, master is now ${newMaster}` : ""));
    if (!this.actors.size) { this.log(`closed ${this.name}`); this.reset(); return; }
    if (!(this.flags & FLAG.SuppressRoomEvents)) {
      this.broadcast(eventMessage(EV.Leave, [
        [P.ActorList, W.intArray(this.actorList())],
        [P.IsInactive, W.bool(false)],
        newMaster ? [P.MasterClientId, W.int(newMaster)] : null,
        [P.ActorNr, W.int(a.nr)],
      ]), this.actors.values());
    }
  }

  // ---- events -----------------------------------------------------------------------------

  eventFrame(code, raw, sender) {
    return eventMessage(code, [raw ? [P.Data, W.raw(raw)] : null, [P.ActorNr, W.int(sender)]]);
  }

  broadcast(frame, actors) { for (const x of actors) x.conn.send(frame); }

  raiseEvent(a, params) {
    const code = num(params, P.Code) || 0;
    const dp = params.get(P.Data);
    const raw = dp ? dp.raw : null;
    const cache = num(params, P.Cache) || 0;
    const targets = ints(params, P.ActorList);
    switch (cache) {
      case CACHE.RemoveFromRoomCache:
        this.removeCached(code, raw, targets);
        a.conn.send(opResponse(OP.RaiseEvent, 0, null));
        return;
      case CACHE.RemoveFromRoomCacheForActorsLeft:
        this.dropCached((e) => !e.global && !this.actors.has(e.sender));
        a.conn.send(opResponse(OP.RaiseEvent, 0, null));
        return;
      case CACHE.RemoveCache:            // legacy per-actor cache
        this.dropCached((e) => e.sender === a.nr && e.code === code);
        return;
      case CACHE.MergeCache: case CACHE.ReplaceCache:
        this.dropCached((e) => e.sender === a.nr && e.code === code);
        if (!this.addCached(a, code, raw, false)) return;
        break;
      case CACHE.AddToRoomCache: case CACHE.AddToRoomCacheGlobal:
        if (!this.addCached(a, code, raw, cache === CACHE.AddToRoomCacheGlobal)) return;
        break;
      case CACHE.DoNotCache:
        break;
      default:                           // cache slices are not used by the game
        a.conn.send(opResponse(OP.RaiseEvent, 0, null));
        return;
    }
    this.broadcast(this.eventFrame(code, raw, a.nr), this.receivers(a, params, targets));
  }

  receivers(a, params, targets) {
    if (targets) {
      const seen = new Set(), out = [];
      for (const n of targets) { const x = this.actors.get(n); if (x && !seen.has(n)) { seen.add(n); out.push(x); } }
      return out;
    }
    const rg = num(params, P.ReceiverGroup) || RECEIVERS.Others;
    let out;
    if (rg === RECEIVERS.MasterClient) out = this.actors.has(this.master) ? [this.actors.get(this.master)] : [];
    else if (rg === RECEIVERS.All) out = [...this.actors.values()];
    else out = [...this.actors.values()].filter((x) => x !== a);
    const group = num(params, P.Group) || 0;
    if (group) out = out.filter((x) => x.allGroups || x.groups.has(group));
    return out;
  }

  addCached(a, code, raw, global) {
    const n = raw ? raw.length : 0;
    if (this.cache.length >= CACHE_MAX_EVENTS || this.cacheBytes + n > CACHE_MAX_BYTES) {
      this.log(`event cache full in ${this.name}`);
      a.conn.send(opResponse(OP.RaiseEvent, ERR.OperationLimitReached, "Room event cache is full"));
      return false;
    }
    this.cache.push({ sender: a.nr, code, raw: raw ? raw.slice() : null, global });
    this.cacheBytes += n;
    return true;
  }

  dropCached(pred) {
    const keep = [];
    let bytes = 0;
    for (const e of this.cache) if (!pred(e)) { keep.push(e); bytes += e.raw ? e.raw.length : 0; }
    this.cache = keep;
    this.cacheBytes = bytes;
  }

  // RemoveFromRoomCache: event code 0 matches any code; target actors (if given) limit the
  // senders; a Hashtable as data matches cached events whose data contains all its entries.
  removeCached(code, raw, targets) {
    const filter = raw ? decodeRaw(raw) : null;
    const senders = targets ? new Set(targets) : null;
    this.dropCached((e) => {
      if (code && e.code !== code) return false;
      if (senders && (e.global || !senders.has(e.sender))) return false;
      if (filter == null) return true;
      if (e.data === undefined) e.data = e.raw ? decodeRaw(e.raw) : null;
      if (filter instanceof PTable) {
        if (!(e.data instanceof PTable)) return false;
        return filter.entries.every((f) => { const d = e.data.entries.find((x) => sameKey(x, f)); return d && sameValue(d.v, f.v); });
      }
      return sameValue(e.data, filter);
    });
  }

  // ---- properties ---------------------------------------------------------------------------

  setProperties(a, params) {
    const op = OP.SetProperties;
    const pp = params.get(P.Properties);
    const table = pp && pp.type === T.Hashtable ? decodeRaw(pp.raw) : null;
    if (!(table instanceof PTable)) { a.conn.send(opResponse(op, ERR.InvalidOperation, "Properties missing")); return; }
    const targetNr = num(params, P.ActorNr) || 0;
    const target = targetNr > 0 ? this.actors.get(targetNr) : null;
    if (targetNr > 0 && !target) { a.conn.send(opResponse(op, ERR.InvalidOperation, "Actor " + targetNr + " not found")); return; }
    const store = target ? target.props : this.props;

    const ep = params.get(P.ExpectedValues);
    const expected = ep && ep.type === T.Hashtable ? decodeRaw(ep.raw) : null;
    if (expected instanceof PTable) {
      for (const x of expected.entries) {
        const cur = store.get(x);
        if (!sameValue(cur ? cur.v : null, x.v)) {
          a.conn.send(opResponse(op, ERR.InvalidOperation, "CAS update failed: property " + JSON.stringify(x.k) + " changed"));
          return;
        }
      }
    }
    if (!target) {
      const m = table.entries.find((e) => e.kt === T.Byte && e.k === GP.MasterClientId);
      if (m && !(typeof m.v === "number" && this.actors.has(m.v))) {
        a.conn.send(opResponse(op, ERR.InvalidOperation, "New master client is not in the room"));
        return;
      }
    }
    for (const e of table.entries) {
      if (e.v === null && this.flags & FLAG.DeleteNullProps) store.delete(e);
      else store.set(e);
    }
    if (!target) {
      const scn = table.entries.find((e) => e.k === "curScn");
      if (scn) this.log(`scene ${JSON.stringify(scn.v)} in ${this.name}`);
      this.applyRoomProps();
      const m = this.props.getByte(GP.MasterClientId);
      if (m && typeof m.v === "number" && m.v !== this.master) { this.log(`master set to ${m.v} in ${this.name}`); this.master = m.v; }
    }
    a.conn.send(opResponse(op, 0, null));
    if (bool(params, P.Broadcast)) {
      const toAll = this.flags & FLAG.BroadcastPropsChangeToAll;
      const frame = eventMessage(EV.PropertiesChanged, [
        [P.Properties, W.raw(pp.raw)],
        [P.TargetActorNr, W.int(targetNr)],
        [P.ActorNr, W.int(a.nr)],
      ]);
      this.broadcast(frame, [...this.actors.values()].filter((x) => toAll || x !== a));
    }
  }

  getProperties(a) {
    a.conn.send(opResponse(OP.GetProperties, 0, null, [
      [P.GameProperties, this.props.writer()],
      [P.PlayerProperties, W.hash([...this.actors.values()].map((o) => [W.int(o.nr), o.props.writer()]))],
    ]));
  }

  // Interest groups: an empty "remove" list leaves all groups, an empty "add" list joins all.
  changeGroups(a, params) {
    const rp = params.get(P.Remove), ap = params.get(P.Add);
    const rem = rp ? decodeRaw(rp.raw) : null, add = ap ? decodeRaw(ap.raw) : null;
    if (rem instanceof Uint8Array) {
      if (!rem.length) { a.groups.clear(); a.allGroups = false; }
      else for (const g of rem) a.groups.delete(g);
    }
    if (add instanceof Uint8Array) {
      if (!add.length) a.allGroups = true;
      else for (const g of add) a.groups.add(g);
    }
  }
}
