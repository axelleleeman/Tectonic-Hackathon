// Server-side life-moment detection. The client never decides what was detected.
import { CONSENT_CATEGORIES, MOMENTS, MOMENTS_BY_ID, THRESHOLD, WINDOW_YEARS } from "./content.js";
import { key } from "./store.js";

export function loadConsent(store, customerId) {
  const consent = {};
  for (const c of Object.keys(CONSENT_CATEGORIES)) {
    const k = key(customerId, c);
    consent[c] = Object.hasOwn(store.data.consent, k) ? store.data.consent[k] : true;
  }
  return consent;
}

function score(moment, kinds, consent) {
  const signals = [];
  let conf = 0;
  for (const s of moment.signals) {
    if (!kinds.has(s.kind)) continue;
    const used = consent[s.source] === true;
    signals.push({ text: s.text, category: CONSENT_CATEGORIES[s.source], weight: s.weight, used });
    if (used) conf += s.weight;
  }
  return { conf: Math.min(Math.round(conf * 100) / 100, 0.99), signals };
}

export function detect(store, customerId, age) {
  const events = store.data.events[customerId] || [];
  const kinds = new Set(events.filter(e => e.age > age - WINDOW_YEARS && e.age <= age).map(e => e.kind));
  if (!kinds.size) return { moment: null, conf: 0, signals: [] };
  const consent = loadConsent(store, customerId);
  let best = null;
  for (const m of MOMENTS) {
    const r = score(m, kinds, consent);
    if (r.signals.length && (!best || r.conf > best.conf)) best = { moment: m, ...r };
  }
  return best || { moment: null, conf: 0, signals: [] };
}

export const getAnswer = (store, customerId, momentId) => store.data.answers[key(customerId, momentId)] || null;

export function decide(conf, answer) {
  if (answer === "no") return "dismissed";
  if (answer === "yes") return "act";
  return conf >= THRESHOLD ? "ask" : "none";
}

export function currentDecision(store, customerId, age) {
  const d = detect(store, customerId, age);
  if (!d.moment) return { ...d, decision: "none" };
  return { ...d, decision: decide(d.conf, getAnswer(store, customerId, d.moment.id)) };
}

// Timeline markers: the first age at which each moment appears in this customer's data.
export function momentAges(store, customerId) {
  const kindToMoment = {};
  for (const m of MOMENTS) for (const s of m.signals) kindToMoment[s.kind] = m.id;
  const seen = new Map();
  for (const e of [...(store.data.events[customerId] || [])].sort((a, b) => a.age - b.age)) {
    const id = kindToMoment[e.kind];
    if (id && !seen.has(id)) seen.set(id, e.age);
  }
  return [...seen].map(([id, age]) => ({ id, short: MOMENTS_BY_ID[id].short, age }));
}
