// Moments API: every rule is enforced here, never only in the browser.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONSENT_CATEGORIES, MOMENTS_BY_ID, MOMENT_IDS, OPEN_ASK_OPTIONS, SLOTS, STATS, THRESHOLD } from "./content.js";
import { currentDecision, loadConsent, momentAges } from "./engine.js";
import { key } from "./store.js";
import {
  COOKIE_SECURE, LoginRateLimiter, SECURITY_HEADERS, SESSION_COOKIE, SESSION_TTL_MS,
  parseCookies, randomToken, safeEqual, tokenHash, verifyDummy, verifyPassword,
} from "./security.js";

const FRONTEND = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend");
const COINS_PER_EURO = 100; // demo conversion rate

class HttpError extends Error {
  constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
}
const fail = (status, detail) => { throw new HttpError(status, detail); };

// ---------- input validation ----------
function strictBody(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(422, "Invalid body");
  for (const k of Object.keys(body)) if (!allowed.includes(k)) fail(422, `Unknown field: ${k}`);
  return body;
}
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
function ageFrom(v) {
  const n = typeof v === "string" && /^\d{1,3}$/.test(v) ? Number(v) : v;
  if (!isInt(n, 18, 80)) fail(422, "Invalid age");
  return n;
}
function momentFrom(id) {
  if (typeof id !== "string" || !MOMENT_IDS.has(id)) fail(422, "Unknown life moment");
  return id;
}

export function createApp(store) {
  const app = express();
  const limiter = new LoginRateLimiter();
  app.locals.limiter = limiter;
  app.disable("x-powered-by");
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1); // behind Cloud Run's proxy

  app.use((req, res, next) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (COOKIE_SECURE()) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api", express.json({ limit: "10kb", strict: true }));

  // ---------- sessions ----------
  function sessionOf(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const s = store.data.sessions[tokenHash(token)];
    if (!s || s.expiresAt < Date.now()) return null;
    const user = store.userById(s.userId);
    return user ? { ...s, token, user } : null;
  }
  const auth = (req, res, next) => {
    const s = sessionOf(req);
    if (!s) return next(new HttpError(401, "Not logged in"));
    req.session = s;
    next();
  };
  const csrf = (req, res, next) => {
    if (!safeEqual(req.session.csrf, req.get("X-CSRF-Token"))) return next(new HttpError(403, "Invalid CSRF token"));
    next();
  };
  const customer = (req, res, next) => {
    if (req.session.user.role !== "customer" || !req.session.user.customerId) return next(new HttpError(403, "Customers only"));
    req.customerId = req.session.user.customerId; // always from the session, never from the request
    next();
  };
  const advisor = (req, res, next) => {
    if (req.session.user.role !== "advisor") return next(new HttpError(403, "Advisors only"));
    next();
  };
  const customerRead = [auth, customer];
  const customerWrite = [auth, csrf, customer];

  // ---------- auth ----------
  app.post("/api/login", (req, res) => {
    const body = strictBody(req.body, ["username", "password"]);
    const { username, password } = body;
    if (typeof username !== "string" || typeof password !== "string" || !username || !password ||
        username.length > 64 || password.length > 256) fail(422, "Invalid login");
    const name = username.trim().toLowerCase();
    const limitKey = `${name}|${req.ip}`;
    if (limiter.blocked(limitKey)) fail(429, "Too many attempts, try again later");
    const user = Object.hasOwn(store.data.users, name) ? store.data.users[name] : null;
    let ok = false;
    if (user) ok = verifyPassword(password, user.hash, user.salt);
    else verifyDummy(password);
    if (!ok) { limiter.fail(limitKey); fail(401, "Wrong username or password"); } // same message for unknown users
    limiter.reset(limitKey);

    const old = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (old) delete store.data.sessions[tokenHash(old)]; // no session fixation
    for (const [h, s] of Object.entries(store.data.sessions)) if (s.expiresAt < Date.now()) delete store.data.sessions[h];
    const token = randomToken(), csrfToken = randomToken();
    store.data.sessions[tokenHash(token)] = { userId: user.id, csrf: csrfToken, expiresAt: Date.now() + SESSION_TTL_MS };
    store.save();
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: COOKIE_SECURE(), sameSite: "strict", maxAge: SESSION_TTL_MS, path: "/" });
    res.json({ csrf: csrfToken, user: { name: user.displayName, role: user.role } });
  });

  app.post("/api/logout", auth, csrf, (req, res) => {
    delete store.data.sessions[tokenHash(req.session.token)];
    store.save();
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  app.get("/api/me", auth, (req, res) => {
    res.json({ csrf: req.session.csrf, user: { name: req.session.user.displayName, role: req.session.user.role } });
  });

  // ---------- view model ----------
  const euros = c => `${c < 0 ? "-" : "+"}€${(Math.abs(c) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2 })}`;

  function buildView(cid, age) {
    const c = store.data.customers[cid];
    const { moment, conf, signals, decision } = currentDecision(store, cid, age);
    const consent = loadConsent(store, cid);
    const settings = store.data.settings[cid];
    const view = {
      age,
      customer: { first_name: c.name.split(" ")[0], kate_coins: c.kateCoins, converted_eur: c.convertedEurCents / 100 },
      consent: Object.entries(CONSENT_CATEGORIES).map(([k, label]) => ({ key: k, label, allowed: consent[k] })),
      kate_coins_recos: settings.kateCoinsRecos,
      everyday: store.data.everyday[cid].map(t => ({ label: t.label, amount: euros(t.cents) })),
      threshold: THRESHOLD,
      moment: null,
    };
    if (!moment) return view;
    const mid = moment.id;
    let reco = { show: false, why: "only after the customer confirms" };
    if ((moment.sensitive || moment.careful) && !moment.partnersOk) reco.why = "off: sensitive moment";
    else if (decision === "act") {
      if (!moment.partners.length) reco.why = "no relevant partners";
      else if (!settings.kateCoinsRecos) reco.why = "off: customer doesn't want Kate Coins recommendations";
      else if (store.data.recoDismissed[key(cid, mid)]) reco = { show: false, why: "dismissed by the customer", undo: true };
      else reco = { show: true, why: `${moment.partners.length} partners, based on '${moment.name}'`, partners: moment.partners };
    }
    const appt = store.data.appointments.find(a => a.customerId === cid && a.momentId === mid);
    view.moment = {
      id: mid, name: moment.name, level: moment.level, channel: moment.channel, timing: moment.timing,
      sensitive: !!moment.sensitive, careful: !!moment.careful, care: moment.care, open_ask: !!moment.openAsk,
      private_messages: !!moment.privateMessages, confidence: conf, signals, decision,
      question: moment.question || null, open_ask_options: OPEN_ASK_OPTIONS, recommendations: reco,
    };
    if (decision === "act") {
      Object.assign(view.moment, {
        title: moment.title, body: moment.body, balance: moment.balance || null,
        actions: moment.actions.map((text, i) => ({ text, done: !!store.data.actionsDone[key(cid, mid, i)] })),
        advisor: moment.advisor ? { topic: moment.advisor, slots: SLOTS, booked: appt ? appt.slot : null } : null,
        tips: moment.tips,
      });
    }
    return view;
  }

  // Business rule: you can only act on the moment the engine detects at this age,
  // and most actions only after the customer confirmed it.
  function requireCurrent(cid, age, momentId, needConfirmed = false) {
    const d = currentDecision(store, cid, age);
    if (!d.moment || d.moment.id !== momentId) fail(409, "This life moment is not active");
    if (needConfirmed && d.decision !== "act") fail(409, "The customer has not confirmed this life moment");
    return d;
  }

  // ---------- customer endpoints: scoped to the logged-in customer ----------
  app.get("/api/me/timeline", customerRead, (req, res) => {
    res.json({ min_age: 22, max_age: 67, markers: momentAges(store, req.customerId) });
  });

  app.get("/api/me/view", customerRead, (req, res) => {
    res.json(buildView(req.customerId, ageFrom(req.query.age)));
  });

  app.put("/api/me/consent", customerWrite, (req, res) => {
    const { category, allowed } = strictBody(req.body, ["category", "allowed"]);
    if (typeof category !== "string" || !Object.hasOwn(CONSENT_CATEGORIES, category) || typeof allowed !== "boolean") fail(422, "Invalid consent");
    store.data.consent[key(req.customerId, category)] = allowed;
    store.save();
    res.json({ ok: true });
  });

  app.put("/api/me/settings", customerWrite, (req, res) => {
    const { kate_coins_recos } = strictBody(req.body, ["kate_coins_recos"]);
    if (typeof kate_coins_recos !== "boolean") fail(422, "Invalid setting");
    store.data.settings[req.customerId].kateCoinsRecos = kate_coins_recos;
    store.save();
    res.json({ ok: true });
  });

  app.post("/api/me/moments/:momentId/answer", customerWrite, (req, res) => {
    const mid = momentFrom(req.params.momentId);
    const body = strictBody(req.body, ["age", "answer", "choice"]);
    const age = ageFrom(body.age);
    if (body.answer !== "yes" && body.answer !== "no") fail(422, "Invalid answer");
    if (body.choice !== undefined && body.choice !== null) momentFrom(body.choice);
    const d = requireCurrent(req.customerId, age, mid);
    if (d.decision !== "ask") fail(409, "Nothing to answer");
    if (d.moment.openAsk && body.answer === "yes" && body.choice !== mid) return res.json({ matched: false });
    store.data.answers[key(req.customerId, mid)] = body.answer;
    store.save();
    res.json({ matched: true });
  });

  app.post("/api/me/moments/:momentId/reset", customerWrite, (req, res) => {
    const mid = momentFrom(req.params.momentId);
    const age = ageFrom(strictBody(req.body, ["age"]).age);
    requireCurrent(req.customerId, age, mid);
    const k = key(req.customerId, mid);
    if (store.data.answers[k] === "no") { delete store.data.answers[k]; store.save(); }
    res.json({ ok: true });
  });

  app.post("/api/me/moments/:momentId/actions/:index/toggle", customerWrite, (req, res) => {
    const mid = momentFrom(req.params.momentId);
    const index = /^\d{1,2}$/.test(req.params.index) ? Number(req.params.index) : -1;
    const age = ageFrom(strictBody(req.body, ["age"]).age);
    const { moment } = requireCurrent(req.customerId, age, mid, true);
    if (index < 0 || index >= moment.actions.length) fail(404, "Unknown action");
    const k = key(req.customerId, mid, index);
    if (store.data.actionsDone[k]) delete store.data.actionsDone[k]; else store.data.actionsDone[k] = true;
    store.save();
    res.json({ ok: true });
  });

  app.post("/api/me/moments/:momentId/appointment", customerWrite, (req, res) => {
    const mid = momentFrom(req.params.momentId);
    const body = strictBody(req.body, ["age", "slot"]);
    const age = ageFrom(body.age);
    if (!SLOTS.includes(body.slot)) fail(422, "Invalid time slot");
    const { moment } = requireCurrent(req.customerId, age, mid, true);
    if (!moment.advisor) fail(409, "No advisor for this moment");
    const assignment = store.data.assignments.find(a => a.customerId === req.customerId);
    if (!assignment) fail(409, "No advisor assigned");
    if (store.data.appointments.some(a => a.customerId === req.customerId && a.momentId === mid)) fail(409, "Already booked");
    store.data.appointments.push({ customerId: req.customerId, momentId: mid, slot: body.slot, advisorId: assignment.advisorId });
    store.save();
    res.json({ ok: true });
  });

  app.post("/api/me/moments/:momentId/recommendations/dismiss", customerWrite, (req, res) => {
    const mid = momentFrom(req.params.momentId);
    requireCurrent(req.customerId, ageFrom(strictBody(req.body, ["age"]).age), mid, true);
    store.data.recoDismissed[key(req.customerId, mid)] = true;
    store.save();
    res.json({ ok: true });
  });

  app.post("/api/me/moments/:momentId/recommendations/restore", customerWrite, (req, res) => {
    const mid = momentFrom(req.params.momentId);
    strictBody(req.body, ["age"]);
    delete store.data.recoDismissed[key(req.customerId, mid)];
    store.save();
    res.json({ ok: true });
  });

  app.post("/api/me/kate-coins/convert", customerWrite, (req, res) => {
    // Converts only the coins that are still there, in one synchronous step:
    // a double click or replayed request converts nothing twice.
    const c = store.data.customers[req.customerId];
    if (c.kateCoins <= 0) fail(409, "No Kate Coins left to convert");
    c.convertedEurCents += Math.floor((c.kateCoins * 100) / COINS_PER_EURO);
    c.kateCoins = 0;
    store.save();
    res.json({ converted_eur: c.convertedEurCents / 100 });
  });

  // ---------- advisor endpoints: only customers assigned to this advisor ----------
  const assigned = (advisorId, customerId) => store.data.assignments.some(a => a.advisorId === advisorId && a.customerId === customerId);

  app.get("/api/advisor/appointments", auth, advisor, (req, res) => {
    const mine = store.data.appointments.filter(a => assigned(req.session.user.id, a.customerId));
    res.json(mine.map(a => ({ customer: store.data.customers[a.customerId].name, moment: MOMENTS_BY_ID[a.momentId].name, slot: a.slot })));
  });

  app.get("/api/advisor/customers/:customerId/view", auth, advisor, (req, res) => {
    const cid = /^\d{1,9}$/.test(req.params.customerId) ? Number(req.params.customerId) : -1;
    const age = ageFrom(req.query.age);
    if (!assigned(req.session.user.id, cid)) fail(404, "Not found"); // don't reveal whether the customer exists
    res.json(buildView(cid, age));
  });

  // ---------- dashboard ----------
  app.get("/api/stats", auth, (req, res) => res.json({ synthetic: true, ...STATS }));

  app.use("/api", (req, res, next) => next(new HttpError(404, "Not found")));
  app.use(express.static(FRONTEND, { index: "index.html", dotfiles: "deny" }));

  // Never leak stack traces or internals to the client.
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ detail: err.detail });
    if (err.type === "entity.parse.failed" || err.type === "entity.too.large") return res.status(400).json({ detail: "Invalid request body" });
    console.error(err);
    res.status(500).json({ detail: "Internal error" });
  });

  return app;
}
