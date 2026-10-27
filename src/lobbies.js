// Lobby list: every room reports a summary here (on changes and every 30 s); the page asks
// for the public lobbies that haven't started, and whether a code exists before joining.
// Kept in memory only: after a restart the list refills from the rooms' next reports.

export const STALE_MS = 75000;          // two missed reports
const MAX_ROOMS = 2000;

export function cleanName(v) {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 24) : "";
}

export class Lobbies {
  constructor() { this.rooms = new Map(); }

  prune(now) { for (const [k, r] of this.rooms) if (now - r.at > STALE_MS) this.rooms.delete(k); }

  put(key, s, now) {
    if (typeof key !== "string" || !key || !s || typeof s.code !== "string") return;
    if (!s.created) { this.rooms.delete(key); return; }
    if (!this.rooms.has(key) && this.rooms.size >= MAX_ROOMS) return;
    this.rooms.set(key, {
      code: s.code.slice(0, 24), host: cleanName(s.host), ver: String(s.ver || "").slice(0, 40),
      players: s.players | 0, max: s.max | 0, open: s.open !== false, started: !!s.started, pub: !!s.pub,
      since: (this.rooms.get(key) || {}).since || now, at: now,
    });
  }

  del(key) { this.rooms.delete(key); }

  joinable(r) { return r.open && !r.started && (!r.max || r.players < r.max); }

  // public lobbies anyone can join right now, newest first
  list(now) {
    this.prune(now);
    return [...this.rooms.values()].filter((r) => r.pub && this.joinable(r))
      .sort((a, b) => b.since - a.since).slice(0, 50)
      .map((r) => ({ code: r.code, host: r.host, players: r.players, max: r.max, ver: r.ver }));
  }

  // state of a code (public or not); no names, so a private room stays private
  find(code, now) {
    this.prune(now);
    const hits = [...this.rooms.values()].filter((r) => r.code === code);
    if (!hits.length) return { exists: false };
    const r = hits.find((x) => this.joinable(x)) || hits[0];
    return { exists: true, open: r.open, started: r.started, full: !!r.max && r.players >= r.max };
  }
}
