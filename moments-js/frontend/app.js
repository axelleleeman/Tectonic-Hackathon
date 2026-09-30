"use strict";
// All decisions happen on the server. The browser only shows the view model and sends user intents.

const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"'`]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;","`":"&#96;"}[c]));

let csrf = null;
let view = null;
// Pure UI state (not security relevant)
const ui = { recoOpen: {}, askOpen: {}, slot: {}, msg: "" };

async function api(method, path, body) {
  const opts = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  if (method !== "GET" && csrf) opts.headers["X-CSRF-Token"] = csrf;
  const res = await fetch(path, opts);
  if (res.status === 401 && path !== "/api/login") { showLogin(); throw new Error("unauthorised"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.detail || "Request failed"), { status: res.status });
  return data;
}

function show(id) {
  for (const v of ["loginView", "appView", "advisorView"]) $(v).classList.toggle("hidden", v !== id);
}
function showLogin() { csrf = null; show("loginView"); }

// ---------- login ----------
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("loginErr").textContent = "";
  try {
    const r = await api("POST", "/api/login", { username: $("username").value.trim(), password: $("password").value });
    $("password").value = "";
    await start(r);
  } catch (err) {
    $("loginErr").textContent = err.status === 429 ? "Too many attempts, try again later." : "Wrong username or password.";
  }
});

async function logout() { try { await api("POST", "/api/logout"); } catch (e) {} showLogin(); }
$("logoutBtn").onclick = logout;
$("advLogout").onclick = logout;

async function start(session) {
  csrf = session.csrf;
  if (session.user.role === "advisor") {
    $("advName").textContent = session.user.name;
    show("advisorView");
    const appts = await api("GET", "/api/advisor/appointments");
    $("appts").innerHTML = appts.length ? appts.map(a => `<div class="appt"><b>${esc(a.customer)}</b> · ${esc(a.moment)} · ${esc(a.slot)}</div>`).join("")
      : `<p class="empty">No appointments yet.</p>`;
    return;
  }
  $("whoName").textContent = session.user.name;
  show("appView");
  const tl = await api("GET", "/api/me/timeline");
  buildTimeline(tl);
  loadStats();
  await refresh();
}

// ---------- timeline ----------
const pct = (a, min, max) => (a - min) / (max - min) * 100;
function buildTimeline(tl) {
  const range = $("age");
  range.min = tl.min_age; range.max = tl.max_age;
  document.querySelectorAll(".mk").forEach(b => b.remove());
  tl.markers.forEach((m, i) => {
    const b = document.createElement("button");
    b.className = "mk" + (i % 2 ? " alt" : "");
    b.style.left = pct(m.age, tl.min_age, tl.max_age) + "%";
    b.dataset.age = m.age;
    b.innerHTML = `<span class="lbl">${esc(m.short)} · </span>${esc(m.age)}`;
    b.onclick = () => { range.value = m.age; ui.msg = ""; refresh(); };
    $("tl").appendChild(b);
  });
}
$("age").addEventListener("input", () => { ui.msg = ""; refresh(); });

// ---------- render ----------
let pending = 0;
async function refresh() {
  const age = +$("age").value;
  const token = ++pending;
  const v = await api("GET", `/api/me/view?age=${encodeURIComponent(age)}`);
  if (token !== pending) return; // a newer request is on its way
  view = v;
  render();
}

function render() {
  const v = view, m = v.moment;
  $("custName").textContent = v.customer.first_name;
  $("ageLbl").innerHTML = `${esc(v.age)} <small>years</small>`;
  document.querySelectorAll(".mk").forEach(b => b.classList.toggle("on", !!m && m.decision !== "none" && Math.abs(+b.dataset.age - v.age) < 2 && +b.dataset.age <= v.age));
  renderConsent(v);

  if (!m) {
    $("signals").innerHTML = `<p class="empty">An ordinary month: salary, groceries, fixed costs. Nothing unusual.</p>`;
    $("engine").innerHTML = `<span class="pill p-none">No moment</span><p>The engine sees no life moment, so it does nothing. That's personalisation too: no noise.</p>`;
    renderPhone("", null, "");
    return;
  }

  $("signals").innerHTML = m.signals.map(s => `
    <div class="sig ${s.used ? "" : "off"}"><div>${esc(s.text)}<div class="w">${s.used ? "weight " + Math.round(s.weight * 100) + "%" : "not used: no consent"}</div></div>
    <span class="tag">${esc(s.category)}</span></div>`).join("");

  const d = m.decision;
  const label = { act: ["Act", "p-act"], ask: ["Ask first", "p-ask"], none: ["Do nothing", "p-none"], dismissed: ["Customer said no", "p-none"] }[d];
  const r = m.recommendations;
  $("engine").innerHTML = `
    <div class="mname">${esc(m.name)}</div>
    <div class="w">Confidence: ${Math.round(m.confidence * 100)}%${d === "act" ? " · confirmed by customer" : ""}</div>
    <div class="bar"><i data-w="${m.confidence * 100}"></i><div class="th" data-left="${v.threshold * 100}"><span>threshold</span></div></div>
    <span class="pill ${label[1]}">${label[0]}</span>
    ${m.sensitive ? ` <span class="pill p-stop">Sensitive: selling paused</span>` : ""}${m.careful ? ` <span class="pill p-ask">Careful: no rush, no push</span>` : ""}
    <dl>
      <dt>Sensitivity</dt><dd>${esc(m.level)}</dd>
      <dt>Channel</dt><dd>${d === "ask" ? "In-app (question)" : d === "act" ? esc(m.channel) : "–"}</dd>
      <dt>Language model</dt><dd>${d === "act" ? "Yes, only to write the text" : "No: no cost"}</dd>
      <dt>Timing</dt><dd>${d === "act" ? esc(m.timing) : "–"}</dd>
      <dt>Kate Coins</dt><dd>${esc(r.why)}${r.undo ? ` · <a href="#" id="recoUndo">restore</a>` : ""}</dd>
    </dl>
    ${d === "ask" && m.open_ask ? `<div class="note">KBC notices a change but never names it. The customer chooses what happened, or says nothing changed.</div>` : ""}
    ${d === "ask" && !m.open_ask ? `<div class="note">Enough signals, but KBC always lets the customer confirm a life moment first. The proposal only follows after "Yes".</div>` : ""}
    ${d === "none" ? `<div class="note">Not confident enough. Better nothing than something irrelevant.</div>` : ""}
    ${d === "dismissed" ? `<div class="note">KBC remembers this and won't ask again. <a href="#" id="reset">Reset</a></div>` : ""}`;

  let extra = "";
  if (d === "act") extra = actCard(m);
  else if (d === "ask" && m.open_ask) extra = openAskCard(m);
  else if (d === "ask") extra = `<div class="card push"><div class="ch">Quick question</div><h3>${esc(m.question)}</h3>
      <p>Then we can help you better. Your answer stays with us.</p>
      <div class="btns"><button class="btn" id="yes">Yes</button><button class="btn ghost" id="no">No</button></div></div>`;
  else if (d === "dismissed") extra = `<div class="card"><p class="m0">Okay, we won't ask again.</p></div>`;
  if (r.undo) extra = `<div class="toast">Recommendations hidden. You'll see fewer offers like this.</div>` + extra;
  renderPhone(extra, d === "act" ? m.balance : null, r.show ? recoHTML(m) : "");
  bindMoment(m);
}

function renderConsent(v) {
  $("consent").innerHTML = v.consent.map(c => `<label class="toggle"><span>${esc(c.label)}</span><input type="checkbox" data-cat="${esc(c.key)}" ${c.allowed ? "checked" : ""}></label>`).join("")
    + `<label class="toggle consent-extra"><span>Kate Coins recommendations</span><input type="checkbox" id="recoSetting" ${v.kate_coins_recos ? "checked" : ""}></label>`;
  $("consent").querySelectorAll("input[data-cat]").forEach(i => i.onchange = () => act(() => api("PUT", "/api/me/consent", { category: i.dataset.cat, allowed: i.checked })));
  $("recoSetting").onchange = e => act(() => api("PUT", "/api/me/settings", { kate_coins_recos: e.target.checked }));
}

function actCard(m) {
  const used = m.signals.filter(s => s.used).map(s => `<li>${esc(s.text)}</li>`).join("");
  return `<div class="card ${m.care ? "care" : ""}">${/advisor/i.test(m.channel) ? `<div class="ch">Advisor</div>` : ""}<h3>${esc(m.title)}</h3><p>${esc(m.body)}</p>
    ${m.advisor ? advisorHTML(m) : ""}
    <div class="acts">${m.actions.map((a, i) => `<div class="act"><span>${esc(a.text)}</span><button class="btn sm" data-i="${i}">${a.done ? "✓" : "Do it"}</button></div>`).join("")}</div>
    ${m.tips.length ? `<div class="tips"><div class="ch">Tips</div>${m.tips.map(t => `<div class="tip"><div><b>${esc(t.name)}</b><small>${esc(t.description)}</small></div>${
        t.url ? `<a class="btn ghost sm" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">Visit</a>`
      : t.action === "convert_coins" ? (view.customer.kate_coins > 0 ? `<button class="btn ghost sm" id="convert">Convert</button>` : `<span class="w">✓ €${esc(view.customer.converted_eur.toFixed(2))}</span>`) : ""}</div>`).join("")}</div>` : ""}
    <div class="btns"><button class="btn ghost">Not now</button></div>
    <details><summary>Why am I seeing this?</summary><ul>${used}</ul>You can change this in Settings → Personalisation.</details></div>`;
}

function advisorHTML(m) {
  const a = m.advisor, sel = ui.slot[m.id] ?? a.slots[0];
  return `<div class="adv">
    <div class="adv-h"><div class="avatar">SD<i></i></div>
      <div><b>Sofie, your advisor</b><small>${m.sensitive || m.careful ? "Takes the time you need · free" : "Available now · free, no obligation"}</small></div></div>
    <div class="topic">${esc(a.topic)}</div>
    ${a.booked ? `<div class="done">✓ Appointment booked: ${esc(a.booked)}</div>` :
      `<div class="slots">${a.slots.map(t => `<button class="slot ${t === sel ? "on" : ""}" data-s="${esc(t)}">${esc(t)}</button>`).join("")}</div>
       <button class="go" id="book">Book appointment</button>`}
  </div>`;
}

function openAskCard(m) {
  const open = ui.askOpen[m.id];
  return `<div class="card push"><button class="life" id="askToggle"><span><b>Has something changed in your life?</b></span><span>${open ? "▲" : "›"}</span></button>
    ${open ? `<p class="my10">You don't have to answer. If something changed, we'll adjust your accounts and insurance with you.</p>
      <div class="btns">${m.open_ask_options.map(o => `<button class="btn ghost rep" data-k="${esc(o.id)}">${esc(o.label)}</button>`).join("")}<button class="btn ghost" id="no">Nothing changed</button></div>
      ${ui.msg ? `<p class="w hint2">${esc(ui.msg)}</p>` : ""}` : ""}</div>`;
}

function recoHTML(m) {
  const ps = m.recommendations.partners, open = ui.recoOpen[m.id];
  return `<div class="reco ${open ? "l2" : ""}" id="reco">
    <div class="reco-top"><span class="grow" id="recoGrow" title="Tap to open"><span class="coin">K</span> Kate Coins · Recommended for you <span class="cnt">${ps.length}</span> <span class="arrow">${open ? "▲" : "▼"}</span></span>
      <button class="x" id="recoX" aria-label="Dismiss" title="Not interested">×</button></div>
    <div class="reco-body">
      <div class="chips">${ps.map(p => `<span>${esc(p.category)}</span>`).join("")}</div>
      <div class="offers">${ps.map(p => `<div class="offer"><b>${esc(p.name)} ${p.coins ? `<span class="earn">+${esc(p.coins)} Kate Coins</span>` : ""}</b><small>${esc(p.description)}</small><button class="btn">View</button></div>`).join("")}</div>
      <div class="why">You have ${esc(view.customer.kate_coins)} Kate Coins. Recommended because you're in the moment '${esc(m.name)}'.</div>
    </div></div>`;
}

function renderPhone(extra, balance, top) {
  const y0 = $("screen").scrollTop;
  $("screen").innerHTML = `<div class="status"><span>9:41</span><span>KBC Mobile</span></div>
    ${top}
    <div class="hello">Good afternoon, ${esc(view.customer.first_name)}</div>
    <div class="bal"><span class="w">Current account</span><b>${esc(balance || "€2,431.20")}</b></div>
    ${extra}
    <div class="w mt6">Recent transactions</div>
    <div>${view.everyday.map(t => `<div class="tx"><span>${esc(t.label)}</span><em>${esc(t.amount)}</em></div>`).join("")}</div>`;
  $("screen").scrollTop = y0;
  applyGeometry();
}

// Sizes are set through the CSSOM (allowed by the CSP), not through inline style attributes.
function applyGeometry(root = document) {
  root.querySelectorAll("[data-w]").forEach(el => { el.style.width = Math.max(0, Math.min(100, +el.dataset.w)) + "%"; });
  root.querySelectorAll("[data-left]").forEach(el => { el.style.left = +el.dataset.left + "%"; });
}

// ---------- intents ----------
async function act(fn) {
  try { await fn(); } catch (e) { if (e.message !== "unauthorised") ui.msg = ""; }
  await refresh();
}

function bindMoment(m) {
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  const age = view.age, base = `/api/me/moments/${encodeURIComponent(m.id)}`;
  on("yes", () => act(() => api("POST", `${base}/answer`, { age, answer: "yes" })));
  on("no", () => act(() => api("POST", `${base}/answer`, { age, answer: "no" })));
  on("reset", e => { e.preventDefault(); act(() => api("POST", `${base}/reset`, { age })); });
  on("askToggle", () => { ui.askOpen[m.id] = !ui.askOpen[m.id]; render(); });
  document.querySelectorAll(".rep").forEach(b => b.onclick = () => act(async () => {
    const r = await api("POST", `${base}/answer`, { age, answer: "yes", choice: b.dataset.k });
    ui.msg = r.matched ? "" : "In this demo, pick the option that matches this moment.";
  }));
  document.querySelectorAll(".act .btn").forEach(b => b.onclick = () => act(() => api("POST", `${base}/actions/${encodeURIComponent(b.dataset.i)}/toggle`, { age })));
  document.querySelectorAll(".slot").forEach(b => b.onclick = () => { ui.slot[m.id] = b.dataset.s; render(); });
  on("book", () => act(() => api("POST", `${base}/appointment`, { age, slot: ui.slot[m.id] ?? m.advisor.slots[0] })));
  on("recoX", () => act(() => api("POST", `${base}/recommendations/dismiss`, { age })));
  on("recoUndo", e => { e.preventDefault(); act(() => api("POST", `${base}/recommendations/restore`, { age })); });
  on("recoGrow", () => { ui.recoOpen[m.id] = !ui.recoOpen[m.id]; render(); });
  on("convert", () => act(() => api("POST", "/api/me/kate-coins/convert")));
}

// ---------- dashboard ----------
async function loadStats() {
  const s = await api("GET", "/api/stats");
  const n = x => Number(x).toLocaleString("en-GB");
  $("kpis").innerHTML = [
    [n(s.kpis.customers_scanned), "customers scanned this week"], [n(s.kpis.moments_above_threshold), "moments above the threshold"],
    [s.kpis.llm_share_pct + "%", "of customers triggered an LLM call"], [n(s.kpis.deliberately_not_sent), "actions deliberately not sent"],
  ].map(([b, t]) => `<div class="panel kpi"><b>${esc(b)}</b><span>${esc(t)}</span></div>`).join("");
  const bars = (el, rows) => {
    const max = Math.max(...rows.map(r => r.value));
    $(el).innerHTML = rows.map(r => `<div class="hb ${r.sensitive ? "sens" : ""}"><span>${esc(r.label)}</span><div data-w="${Math.max(2, r.value / max * 100)}"></div><em>${esc(n(r.value))}</em></div>`).join("");
    applyGeometry($(el));
  };
  bars("perMoment", s.per_moment); bars("funnel", s.funnel); bars("channels", s.channels);
}

document.querySelectorAll("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.id === b.dataset.tab));
});

// ---------- boot ----------
api("GET", "/api/me").then(start).catch(() => showLogin());
