// Photon "GpBinaryV18" (Protocol 1.8) wire format, as spoken by the game's Photon client over
// WebSocket. Each WebSocket message carries exactly one Photon message:
//   [0xF3][msgType (| 0x80 when encrypted)][body]
// msgType: 0 init, 1 init response, 2 operation request, 3 operation response, 4 event,
//          5 disconnect reason, 6 internal operation request, 7 internal operation response.
//
// The server only needs to understand a handful of values (room names, actor numbers, property
// tables, cache filters). Everything else (event payloads, property values) is relayed as the
// exact bytes the client sent, so custom types and nested structures survive untouched.

export const T = {
  Unknown: 0, Boolean: 2, Byte: 3, Short: 4, Float: 5, Double: 6, String: 7, Null: 8,
  CompressedInt: 9, CompressedLong: 10, Int1: 11, Int1_: 12, Int2: 13, Int2_: 14,
  L1: 15, L1_: 16, L2: 17, L2_: 18, Custom: 19, Dictionary: 20, Hashtable: 21,
  ObjectArray: 23, OperationRequest: 24, OperationResponse: 25, EventData: 26,
  BooleanFalse: 27, BooleanTrue: 28, ShortZero: 29, IntZero: 30, LongZero: 31,
  FloatZero: 32, DoubleZero: 33, ByteZero: 34, Array: 64, BooleanArray: 66, ByteArray: 67,
  ShortArray: 68, FloatArray: 69, DoubleArray: 70, StringArray: 71, CompressedIntArray: 73,
  CompressedLongArray: 74, CustomTypeArray: 83, DictionaryArray: 84, HashtableArray: 85,
  CustomTypeSlim: 128,
};

export const MSG = { Init: 0, InitResponse: 1, Operation: 2, OperationResponse: 3, Event: 4,
  DisconnectReason: 5, InternalOperation: 6, InternalOperationResponse: 7 };

const utf8d = new TextDecoder();
const utf8e = new TextEncoder();

export class ProtocolError extends Error {}

// ---- reading ---------------------------------------------------------------------------

export class Reader {
  constructor(buf, pos = 0) {
    this.b = buf;
    this.p = pos;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  need(n) { if (this.p + n > this.b.length) throw new ProtocolError("truncated message"); }
  u8() { this.need(1); return this.b[this.p++]; }
  u16() { this.need(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  i16() { this.need(2); const v = this.dv.getInt16(this.p, true); this.p += 2; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  f64() { this.need(8); const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  skip(n) { this.need(n); this.p += n; }
  bytes(n) { this.need(n); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  // unsigned LEB128, up to 32 bits
  uvar() {
    let r = 0, s = 0, b;
    do { b = this.u8(); if (s < 32) r |= (b & 0x7f) << s; s += 7; } while (b & 0x80 && s < 70);
    return r >>> 0;
  }
  // unsigned LEB128, up to 64 bits, returned as a Number (exact below 2^53)
  uvar64() {
    let r = 0, m = 1, b, s = 0;
    do { b = this.u8(); r += (b & 0x7f) * m; m *= 128; s += 7; } while (b & 0x80 && s < 70);
    return r;
  }
  zz32() { const u = this.uvar(); return (u >>> 1) ^ -(u & 1); }
  zz64() { const u = this.uvar64(); return u % 2 === 0 ? u / 2 : -(u + 1) / 2; }
  str() { const n = this.uvar(); return utf8d.decode(this.bytes(n)); }
}

// Skips one value of the given type (type byte already consumed).
export function skipValue(r, t) {
  if (t >= 128) { r.skip(r.uvar()); return; }
  switch (t) {
    case T.Unknown: case T.Null: case T.BooleanFalse: case T.BooleanTrue: case T.ShortZero:
    case T.IntZero: case T.LongZero: case T.FloatZero: case T.DoubleZero: case T.ByteZero:
      return;
    case T.Boolean: case T.Byte: case T.Int1: case T.Int1_: case T.L1: case T.L1_: r.skip(1); return;
    case T.Short: case T.Int2: case T.Int2_: case T.L2: case T.L2_: r.skip(2); return;
    case T.Float: r.skip(4); return;
    case T.Double: r.skip(8); return;
    case T.String: r.skip(r.uvar()); return;
    case T.CompressedInt: r.uvar(); return;
    case T.CompressedLong: r.uvar64(); return;
    case T.Custom: r.skip(1); r.skip(r.uvar()); return;
    case T.Dictionary: { const h = readDictHeader(r); skipDictBody(r, h); return; }
    case T.Hashtable: { const n = r.uvar(); for (let i = 0; i < n; i++) { skipValue(r, r.u8()); skipValue(r, r.u8()); } return; }
    case T.ObjectArray: case T.Array: { const n = r.uvar(); for (let i = 0; i < n; i++) skipValue(r, r.u8()); return; }
    case T.OperationRequest: r.skip(1); skipParams(r); return;
    case T.OperationResponse: r.skip(3); skipValue(r, r.u8()); skipParams(r); return;
    case T.EventData: r.skip(1); skipParams(r); return;
    case T.BooleanArray: { const n = r.uvar(); r.skip((n + 7) >> 3); return; }
    case T.ByteArray: r.skip(r.uvar()); return;
    case T.ShortArray: r.skip(r.uvar() * 2); return;
    case T.FloatArray: r.skip(r.uvar() * 4); return;
    case T.DoubleArray: r.skip(r.uvar() * 8); return;
    case T.StringArray: { const n = r.uvar(); for (let i = 0; i < n; i++) r.skip(r.uvar()); return; }
    case T.CompressedIntArray: { const n = r.uvar(); for (let i = 0; i < n; i++) r.uvar(); return; }
    case T.CompressedLongArray: { const n = r.uvar(); for (let i = 0; i < n; i++) r.uvar64(); return; }
    case T.CustomTypeArray: { const n = r.uvar(); r.skip(1); for (let i = 0; i < n; i++) r.skip(r.uvar()); return; }
    case T.DictionaryArray: { const h = readDictHeader(r); const n = r.uvar(); for (let i = 0; i < n; i++) skipDictBody(r, h); return; }
    case T.HashtableArray: { const n = r.uvar(); for (let i = 0; i < n; i++) skipValue(r, T.Hashtable); return; }
    default: throw new ProtocolError("unknown type " + t);
  }
}

// Dictionary header: key type, value type; a Dictionary value type carries a nested header,
// an Array value type is followed by its element type(s) and then elements are fully typed.
function readDictHeader(r) {
  const k = r.u8();
  let v = r.u8();
  if (v === T.Dictionary) readDictHeader(r);
  else if (v === T.Array) { let e = r.u8(); while (e === T.Array) e = r.u8(); v = T.Unknown; }
  return { k, v };
}
function skipDictBody(r, h) {
  const n = r.uvar();
  for (let i = 0; i < n; i++) {
    skipValue(r, h.k === T.Unknown ? r.u8() : h.k);
    skipValue(r, h.v === T.Unknown ? r.u8() : h.v);
  }
}
function decodeDictBody(r, h) {
  const n = r.uvar(), out = new PTable();
  for (let i = 0; i < n; i++) {
    const ks = r.p, kt = h.k === T.Unknown ? r.u8() : h.k, k = decodeValue(r, kt);
    const vs = r.p, vt = h.v === T.Unknown ? r.u8() : h.v, v = decodeValue(r, vt);
    out.push(k, null, v, null, kt, vt, ks, vs);
  }
  return out;
}

// A decoded Hashtable / Dictionary. Entries keep the raw bytes (type byte included) of keys and
// values when they were read from a Hashtable, so they can be re-sent exactly.
export class PTable {
  constructor() { this.entries = []; }
  push(k, kr, v, vr, kt, vt) { this.entries.push({ k, kr, v, vr, kt, vt }); }
  get size() { return this.entries.length; }
  find(pred) { return this.entries.find(pred); }
  // well-known Photon property keys are bytes; custom ones are strings
  byteKey(b) { return this.entries.find((e) => e.kt === T.Byte && e.k === b) || (b === 0 ? this.entries.find((e) => e.kt === T.ByteZero) : undefined); }
  get(key) { return this.entries.find((e) => e.k === key); }
}

export function isIntType(t) {
  return t === T.CompressedInt || t === T.Int1 || t === T.Int1_ || t === T.Int2 || t === T.Int2_ || t === T.IntZero;
}

// Reads one value (type byte already consumed) into a plain JS value.
export function decodeValue(r, t) {
  if (t >= 128) return { custom: t - 128, data: r.bytes(r.uvar()) };
  switch (t) {
    case T.Unknown: case T.Null: return null;
    case T.Boolean: return r.u8() !== 0;
    case T.BooleanFalse: return false;
    case T.BooleanTrue: return true;
    case T.Byte: return r.u8();
    case T.Short: return r.i16();
    case T.Float: return r.f32();
    case T.Double: return r.f64();
    case T.String: return r.str();
    case T.CompressedInt: return r.zz32();
    case T.CompressedLong: return r.zz64();
    case T.Int1: case T.L1: return r.u8();
    case T.Int1_: case T.L1_: return -r.u8();
    case T.Int2: case T.L2: return r.u16();
    case T.Int2_: case T.L2_: return -r.u16();
    case T.ShortZero: case T.IntZero: case T.LongZero: case T.FloatZero: case T.DoubleZero: case T.ByteZero: return 0;
    case T.Custom: { const code = r.u8(); return { custom: code, data: r.bytes(r.uvar()) }; }
    case T.Dictionary: return decodeDictBody(r, readDictHeader(r));
    case T.Hashtable: return readHashtable(r);
    case T.ObjectArray: case T.Array: { const n = r.uvar(), a = []; for (let i = 0; i < n; i++) a.push(decodeValue(r, r.u8())); return a; }
    case T.OperationRequest: { const op = r.u8(); return { op, params: readParams(r) }; }
    case T.OperationResponse: { const op = r.u8(), ret = r.i16(), dbg = decodeValue(r, r.u8()); return { op, ret, dbg, params: readParams(r) }; }
    case T.EventData: { const code = r.u8(); return { code, params: readParams(r) }; }
    case T.BooleanArray: {
      const n = r.uvar(), a = [], bytes = r.bytes((n + 7) >> 3);
      for (let i = 0; i < n; i++) a.push(((bytes[i >> 3] >> (i & 7)) & 1) === 1);
      return a;
    }
    case T.ByteArray: return r.bytes(r.uvar());
    case T.ShortArray: { const n = r.uvar(), a = []; for (let i = 0; i < n; i++) a.push(r.i16()); return a; }
    case T.FloatArray: { const n = r.uvar(), a = []; for (let i = 0; i < n; i++) a.push(r.f32()); return a; }
    case T.DoubleArray: { const n = r.uvar(), a = []; for (let i = 0; i < n; i++) a.push(r.f64()); return a; }
    case T.StringArray: { const n = r.uvar(), a = []; for (let i = 0; i < n; i++) a.push(r.str()); return a; }
    case T.CompressedIntArray: { const n = r.uvar(), a = []; for (let i = 0; i < n; i++) a.push(r.zz32()); return a; }
    case T.CompressedLongArray: { const n = r.uvar(), a = []; for (let i = 0; i < n; i++) a.push(r.zz64()); return a; }
    case T.CustomTypeArray: { const n = r.uvar(), code = r.u8(), a = []; for (let i = 0; i < n; i++) a.push({ custom: code, data: r.bytes(r.uvar()) }); return a; }
    case T.DictionaryArray: { const h = readDictHeader(r), n = r.uvar(), a = []; for (let i = 0; i < n; i++) a.push(decodeDictBody(r, h)); return a; }
    case T.HashtableArray: { const n = r.uvar(), a = []; for (let i = 0; i < n; i++) a.push(readHashtable(r)); return a; }
    default: throw new ProtocolError("unknown type " + t);
  }
}

function readHashtable(r) {
  const n = r.uvar(), out = new PTable();
  for (let i = 0; i < n; i++) {
    const ks = r.p, kt = r.u8(), k = decodeValue(r, kt), ke = r.p;
    const vs = r.p, vt = r.u8(), v = decodeValue(r, vt), ve = r.p;
    out.push(k, r.b.subarray(ks, ke), v, r.b.subarray(vs, ve), kt, vt);
  }
  return out;
}

// Parameter table: [count:u8] then count x ([key:u8][type:u8][value]).
// Values are located, not decoded: { type, raw (type byte included) }. Use paramValue() to decode.
export function readParams(r) {
  const n = r.u8(), out = new Map();
  for (let i = 0; i < n; i++) {
    const key = r.u8(), start = r.p, t = r.u8();
    skipValue(r, t);
    out.set(key, { type: t, raw: r.b.subarray(start, r.p) });
  }
  return out;
}
function skipParams(r) { const n = r.u8(); for (let i = 0; i < n; i++) { r.skip(1); skipValue(r, r.u8()); } }

export function paramValue(params, key) {
  const p = params.get(key);
  if (!p) return undefined;
  return decodeRaw(p.raw);
}
// Decodes a raw typed value (type byte first).
export function decodeRaw(raw) { const r = new Reader(raw); return decodeValue(r, r.u8()); }

// Splits an incoming WebSocket message. Returns { type, encrypted, op?, params?, body }.
export function parseMessage(u8) {
  if (u8.length < 2) throw new ProtocolError("short message");
  if (u8[0] !== 0xf3) throw new ProtocolError("bad magic " + u8[0]);
  const type = u8[1] & 0x7f, encrypted = (u8[1] & 0x80) !== 0;
  const msg = { type, encrypted, body: u8.subarray(2) };
  if (!encrypted && (type === MSG.Operation || type === MSG.InternalOperation)) {
    const r = new Reader(u8, 2);
    msg.op = r.u8();
    msg.params = readParams(r);
  }
  return msg;
}

// ---- writing ---------------------------------------------------------------------------

export class Writer {
  constructor(size = 128) { this.b = new Uint8Array(size); this.n = 0; }
  room(k) {
    if (this.n + k <= this.b.length) return;
    let s = this.b.length * 2; while (s < this.n + k) s *= 2;
    const nb = new Uint8Array(s); nb.set(this.b.subarray(0, this.n)); this.b = nb;
  }
  u8(v) { this.room(1); this.b[this.n++] = v & 0xff; return this; }
  u16(v) { this.room(2); this.b[this.n++] = v & 0xff; this.b[this.n++] = (v >> 8) & 0xff; return this; }
  bytes(a) { this.room(a.length); this.b.set(a, this.n); this.n += a.length; return this; }
  uvar(v) { v >>>= 0; while (v >= 0x80) { this.u8((v & 0x7f) | 0x80); v >>>= 7; } return this.u8(v); }
  done() { return this.b.slice(0, this.n); }
}

// Typed values, encoded the way the Photon client encodes them (smallest form for ints), so
// that the client unboxes them as the CLR type it expects (int, bool, string, int[] ...).
export const W = {
  null: () => (w) => w.u8(T.Null),
  bool: (v) => (w) => w.u8(v ? T.BooleanTrue : T.BooleanFalse),
  byte: (v) => (w) => (v === 0 ? w.u8(T.ByteZero) : w.u8(T.Byte).u8(v)),
  int: (v) => (w) => {
    v |= 0;
    if (v === 0) return w.u8(T.IntZero);
    if (v > 0 && v <= 0xff) return w.u8(T.Int1).u8(v);
    if (v > 0 && v <= 0xffff) return w.u8(T.Int2).u16(v);
    if (v < 0 && v >= -0xff) return w.u8(T.Int1_).u8(-v);
    if (v < 0 && v >= -0xffff) return w.u8(T.Int2_).u16(-v);
    return w.u8(T.CompressedInt).uvar((v << 1) ^ (v >> 31));
  },
  str: (s) => (w) => { const b = utf8e.encode(s); return w.u8(T.String).uvar(b.length).bytes(b); },
  strArray: (a) => (w) => { w.u8(T.StringArray).uvar(a.length); for (const s of a) { const b = utf8e.encode(s); w.uvar(b.length).bytes(b); } return w; },
  intArray: (a) => (w) => { w.u8(T.CompressedIntArray).uvar(a.length); for (const v of a) w.uvar(((v | 0) << 1) ^ ((v | 0) >> 31)); return w; },
  raw: (bytes) => (w) => w.bytes(bytes),
  // entries: array of [keyWriter, valueWriter]
  hash: (entries) => (w) => { w.u8(T.Hashtable).uvar(entries.length); for (const [k, v] of entries) { k(w); v(w); } return w; },
};

// params: array of [key, valueWriter]; undefined writers are skipped
function writeParams(w, params) {
  const list = params.filter((p) => p && p[1]);
  w.u8(list.length);
  for (const [k, v] of list) { w.u8(k); v(w); }
}

export function opResponse(op, ret, debug, params = [], internal = false) {
  const w = new Writer(64);
  w.u8(0xf3).u8(internal ? MSG.InternalOperationResponse : MSG.OperationResponse).u8(op).u16(ret & 0xffff);
  if (debug) W.str(debug)(w); else w.u8(T.Null);
  writeParams(w, params);
  return w.done();
}

export function eventMessage(code, params = []) {
  const w = new Writer(64);
  w.u8(0xf3).u8(MSG.Event).u8(code);
  writeParams(w, params);
  return w.done();
}

export function initResponse() { return new Uint8Array([0xf3, MSG.InitResponse, 0]); }

// ---- value helpers -----------------------------------------------------------------------

// Deep equality of decoded values (used by cache filters and compare-and-set).
export function sameValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (a instanceof PTable && b instanceof PTable) {
    return a.size === b.size && a.entries.every((e) => { const o = b.entries.find((f) => sameValue(f.k, e.k)); return o && sameValue(o.v, e.v); });
  }
  if (typeof a === "object" && typeof b === "object" && "custom" in a && "custom" in b) return a.custom === b.custom && sameValue(a.data, b.data);
  return false;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function hex(u8, max = 4096) {
  let s = ""; const n = Math.min(u8.length, max);
  for (let i = 0; i < n; i++) s += (u8[i] < 16 ? "0" : "") + u8[i].toString(16);
  return n < u8.length ? s + "…" : s;
}
