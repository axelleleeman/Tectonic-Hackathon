// Password hashing, session tokens, CSRF, login rate limiting and security headers.
import crypto from "node:crypto";

export const SESSION_COOKIE = "moments_session";
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_SECONDS || 7200) * 1000;
// Set COOKIE_SECURE=0 only for local development over plain http.
export const COOKIE_SECURE = () => process.env.COOKIE_SECURE !== "0";

const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT);
  return { hash: hash.toString("hex"), salt: salt.toString("hex") };
}

export function verifyPassword(password, hashHex, saltHex) {
  const candidate = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 32, SCRYPT);
  const stored = Buffer.from(hashHex, "hex");
  return stored.length === candidate.length && crypto.timingSafeEqual(candidate, stored);
}

// A dummy hash so a login for an unknown user costs the same time as a real one.
const DUMMY = hashPassword(crypto.randomBytes(16).toString("hex"));
export const verifyDummy = password => { verifyPassword(password, DUMMY.hash, DUMMY.salt); };

export const randomToken = () => crypto.randomBytes(32).toString("base64url");
export const tokenHash = token => crypto.createHash("sha256").update(token).digest("hex");

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class LoginRateLimiter {
  // At most `limit` failed attempts per key within `windowMs`.
  constructor(limit = 5, windowMs = 5 * 60 * 1000) { this.limit = limit; this.windowMs = windowMs; this.fails = new Map(); }
  recent(key) {
    const now = Date.now();
    const list = (this.fails.get(key) || []).filter(t => now - t < this.windowMs);
    this.fails.set(key, list);
    return list;
  }
  blocked(key) { return this.recent(key).length >= this.limit; }
  fail(key) { this.recent(key).push(Date.now()); }
  reset(key) { this.fails.delete(key); }
  clear() { this.fails.clear(); }
}

export const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};
