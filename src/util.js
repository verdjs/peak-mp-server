import { T, W, Writer, decodeRaw, opResponse } from "./protocol.js";
import { OP } from "./codes.js";

// Bytes of one typed value, e.g. enc(W.int(5)).
export function enc(writer) { const w = new Writer(16); writer(w); return w.done(); }

// Typed parameter readers. They return undefined when the parameter is absent or of the
// wrong kind, so callers can apply Photon's defaults.
export function num(params, key) { const p = params.get(key); if (!p) return undefined; const v = decodeRaw(p.raw); return typeof v === "number" ? v : undefined; }
export function bool(params, key) { const p = params.get(key); if (!p) return undefined; const v = decodeRaw(p.raw); return typeof v === "boolean" ? v : undefined; }
export function str(params, key) { const p = params.get(key); if (!p || p.type !== T.String) return undefined; return decodeRaw(p.raw); }
export function ints(params, key) {
  const p = params.get(key); if (!p) return undefined;
  const v = decodeRaw(p.raw);
  if (v instanceof Uint8Array) return Array.from(v);
  return Array.isArray(v) ? v.filter((x) => typeof x === "number") : undefined;
}

// Server clock for pings: milliseconds as a wrapping int32, the same on every server here.
export function serverTime() { return Date.now() | 0; }

// Internal operation 1: echo the client's timestamp, add ours.
export function pingResponse(params) {
  const echo = params && params.get(1);
  return opResponse(OP.Ping, 0, null, [echo ? [1, W.raw(echo.raw)] : null, [2, W.int(serverTime())]], true);
}

// Tokens only carry who the client said it is from the name server to the game server.
// Nothing is secret, so they are plain base64url JSON.
export function b64uEncode(s) {
  const b = new TextEncoder().encode(s); let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64uDecode(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(b);
}
export function makeToken(t) { return b64uEncode(JSON.stringify({ a: t.appId || "", v: t.appVersion || "", u: t.userId || "" })); }
export function readToken(s) {
  if (typeof s !== "string" || s.length > 2048) return null;
  try { const j = JSON.parse(b64uDecode(s)); return { appId: String(j.a || ""), appVersion: String(j.v || ""), userId: String(j.u || "") }; }
  catch (e) { return null; }
}

// Room address segment: one Durable Object per app id + app version + room name.
export function roomKey(t, name) { return b64uEncode([t.appId || "", t.appVersion || "", name].join("\n")); }
export function roomFromKey(key) {
  try { const parts = b64uDecode(key).split("\n"); return parts.length === 3 ? { appId: parts[0], appVersion: parts[1], name: parts[2] } : null; }
  catch (e) { return null; }
}
