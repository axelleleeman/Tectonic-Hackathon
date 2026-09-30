// Security tests: authentication, authorization, IDOR, CSRF and business-logic rules.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DEMO_PASSWORD = "test-password-123";
process.env.COOKIE_SECURE = "0";
const PW = process.env.DEMO_PASSWORD;

const { Store } = await import("../server/store.js");
const { createApp } = await import("../server/app.js");

let server, base, app;
before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moments-"));
  app = createApp(new Store(path.join(dir, "db.json")));
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => app.locals.limiter.clear());

// Minimal client with its own cookie jar.
function client() {
  let cookie = "", csrf = null;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json, headers: res.headers };
  };
  return {
    call,
    get: url => call("GET", url),
    send: (method, url, body) => call(method, url, body, csrf ? { "X-CSRF-Token": csrf } : {}),
    async login(user) {
      const r = await call("POST", "/api/login", { username: user, password: PW });
      assert.equal(r.status, 200);
      csrf = r.json.csrf;
      return r;
    },
  };
}

// ---------- authentication ----------
test("API requires login", async () => {
  const c = client();
  for (const p of ["/api/me", "/api/me/view?age=30", "/api/me/timeline", "/api/stats", "/api/advisor/appointments"])
    assert.equal((await c.get(p)).status, 401, p);
});

test("same error for wrong password and unknown user", async () => {
  const c = client();
  const a = await c.call("POST", "/api/login", { username: "lotte", password: "nope" });
  const b = await c.call("POST", "/api/login", { username: "nobody", password: "nope" });
  const p = await c.call("POST", "/api/login", { username: "__proto__", password: "nope" });
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(p.status, 401);
  assert.deepEqual(a.json, b.json);
});

test("login is rate limited", async () => {
  const c = client();
  for (let i = 0; i < 5; i++) await c.call("POST", "/api/login", { username: "jonas", password: "wrong" });
  assert.equal((await c.call("POST", "/api/login", { username: "jonas", password: PW })).status, 429);
});

test("session cookie is HttpOnly and SameSite=Strict", async () => {
  const r = await client().login("lotte");
  const set = r.headers.get("set-cookie").toLowerCase();
  assert.ok(set.includes("httponly") && set.includes("samesite=strict"));
});

test("logout invalidates the session", async () => {
  const c = client();
  await c.login("lotte");
  assert.equal((await c.send("POST", "/api/logout")).status, 200);
  assert.equal((await c.get("/api/me")).status, 401);
});

// ---------- CSRF ----------
test("state changes need a valid CSRF token", async () => {
  const c = client();
  await c.login("lotte");
  assert.equal((await c.call("PUT", "/api/me/consent", { category: "app", allowed: false })).status, 403);
  assert.equal((await c.call("PUT", "/api/me/consent", { category: "app", allowed: false }, { "X-CSRF-Token": "forged" })).status, 403);
});

// ---------- authorization / IDOR ----------
test("customer data is scoped to the session", async () => {
  const c = client();
  await c.login("jonas");
  const v = (await c.get("/api/me/view?age=32")).json;
  assert.equal(v.customer.first_name, "Jonas");
  assert.equal(v.moment, null); // Lotte's baby moment never leaks into Jonas's view
});

test("customer cannot use advisor endpoints", async () => {
  const c = client();
  await c.login("lotte");
  assert.equal((await c.get("/api/advisor/appointments")).status, 403);
  assert.equal((await c.get("/api/advisor/customers/1/view?age=30")).status, 403);
});

test("advisor only sees assigned customers", async () => {
  const c = client();
  await c.login("sofie"); // assigned to Lotte (1), not to Jonas (2)
  assert.equal((await c.get("/api/advisor/customers/1/view?age=30")).status, 200);
  assert.equal((await c.get("/api/advisor/customers/2/view?age=30")).status, 404);
  assert.equal((await c.get("/api/advisor/customers/999/view?age=30")).status, 404);
});

test("advisor cannot use customer endpoints", async () => {
  const c = client();
  await c.login("sofie");
  assert.equal((await c.get("/api/me/view?age=30")).status, 403);
  assert.equal((await c.send("POST", "/api/me/kate-coins/convert")).status, 403);
});

// ---------- business logic ----------
test("cannot confirm a moment that is not detected", async () => {
  const c = client();
  await c.login("lotte");
  assert.equal((await c.send("POST", "/api/me/moments/baby/answer", { age: 23, answer: "yes" })).status, 409);
});

test("cannot book before confirming", async () => {
  const c = client();
  await c.login("lotte");
  assert.equal((await c.send("POST", "/api/me/moments/home/appointment", { age: 30, slot: "Today 4pm" })).status, 409);
});

test("invalid slot and double booking are rejected", async () => {
  const c = client();
  await c.login("lotte");
  await c.send("POST", "/api/me/moments/home/answer", { age: 30, answer: "yes" });
  assert.equal((await c.send("POST", "/api/me/moments/home/appointment", { age: 30, slot: "Midnight" })).status, 422);
  assert.equal((await c.send("POST", "/api/me/moments/home/appointment", { age: 30, slot: "Fri 2pm" })).status, 200);
  assert.equal((await c.send("POST", "/api/me/moments/home/appointment", { age: 30, slot: "Fri 2pm" })).status, 409);
});

test("open question needs the matching choice", async () => {
  const c = client();
  await c.login("lotte");
  const r = await c.send("POST", "/api/me/moments/divorce/answer", { age: 36, answer: "yes", choice: "job_loss" });
  assert.deepEqual(r.json, { matched: false });
  assert.equal((await c.get("/api/me/view?age=36")).json.moment.decision, "ask");
});

test("Kate Coins convert only once", async () => {
  const c = client();
  await c.login("jonas");
  assert.equal((await c.send("POST", "/api/me/kate-coins/convert")).status, 200);
  assert.equal((await c.send("POST", "/api/me/kate-coins/convert")).status, 409);
});

test("consent is enforced server-side", async () => {
  const c = client();
  await c.login("jonas");
  const before = (await c.get("/api/me/view?age=29")).json.moment.confidence;
  await c.send("PUT", "/api/me/consent", { category: "app", allowed: false });
  const m = (await c.get("/api/me/view?age=29")).json.moment;
  assert.ok(m.confidence < before);
  assert.ok(m.signals.filter(s => s.category === "In-app behaviour").every(s => !s.used));
});

test("sensitive moment shows no Kate Coins", async () => {
  const c = client();
  await c.login("lotte");
  await c.send("POST", "/api/me/moments/job_loss/answer", { age: 41, answer: "yes", choice: "job_loss" });
  const m = (await c.get("/api/me/view?age=41")).json.moment;
  assert.equal(m.decision, "act");
  assert.equal(m.recommendations.show, false);
});

test("unknown fields, ids and bad input are rejected", async () => {
  const c = client();
  await c.login("lotte");
  assert.equal((await c.send("POST", "/api/me/moments/not_a_moment/answer", { age: 30, answer: "yes" })).status, 422);
  assert.equal((await c.send("POST", "/api/me/moments/home/answer", { age: 30, answer: "yes", customer_id: 2 })).status, 422);
  assert.equal((await c.send("POST", "/api/me/moments/__proto__/answer", { age: 30, answer: "yes" })).status, 422);
  assert.equal((await c.send("PUT", "/api/me/consent", { category: "__proto__", allowed: false })).status, 422);
  assert.equal((await c.get("/api/me/view?age=999")).status, 422);
  assert.equal((await c.get("/api/me/view?age=abc")).status, 422);
});

test("security headers are set", async () => {
  const r = await client().get("/");
  assert.ok(r.headers.get("content-security-policy").includes("default-src 'self'"));
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("x-powered-by"), null);
});
