// A small JSON-file data store with synthetic demo data (no native database driver needed).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hashPassword } from "./security.js";

const LOTTE_EVENTS = [
  [23, "transactions", "salary_first"], [23, "transactions", "employer_named"],
  [23, "transactions", "salary_jump"], [23, "transactions", "holiday_pay"],
  [27, "transactions", "rent_shared"], [27, "transactions", "shared_costs"], [27, "transactions", "wedding_deposits"],
  [30, "transactions", "savings_growth"], [30, "app", "mortgage_simulator"],
  [30, "transactions", "notary_deposit"], [30, "transactions", "contractor"],
  [32, "transactions", "baby_shop"], [32, "transactions", "maternity"], [32, "transactions", "groeipakket"],
  [36, "transactions", "partner_stops_joint"], [36, "transactions", "rental_deposit"],
  [36, "customer_data", "address_split"], [36, "transactions", "lawyer"],
  [41, "transactions", "salary_missing"], [41, "transactions", "severance"], [41, "transactions", "unemployment_benefit"],
  [43, "transactions", "multi_client_income"], [43, "transactions", "social_fund"],
  [43, "customer_data", "business_registration"], [43, "transactions", "vat_payment"],
  [52, "transactions", "notary_inflow"], [52, "transactions", "unusual_amount"], [52, "app", "viewed_investing"],
  [63, "transactions", "pension_first"], [63, "transactions", "group_insurance"], [63, "transactions", "holiday_pay_pension"],
];
const JONAS_EVENTS = [
  [24, "transactions", "salary_first"], [24, "transactions", "employer_named"],
  [29, "transactions", "savings_growth"], [29, "app", "mortgage_simulator"],
  [35, "transactions", "multi_client_income"], [35, "transactions", "vat_payment"], [35, "transactions", "social_fund"],
];
const EVERYDAY = [["Colruyt", -6420], ["Salary", 240000], ["Proximus", -4500], ["Bakery De Molen", -780],
  ["Rent / mortgage", -85000], ["Delhaize", -3815], ["NMBS", -1240], ["Pharmacy", -1890],
  ["Spotify", -1199], ["Petrol station", -6200]];

function demoPassword(username) {
  // Demo passwords never live in the code: from the environment, or random and printed once.
  if (process.env.DEMO_PASSWORD) return process.env.DEMO_PASSWORD;
  const pw = crypto.randomBytes(9).toString("base64url");
  console.log(`[seed] demo account '${username}' password: ${pw}`);
  return pw;
}

function seed() {
  const data = {
    customers: {}, users: {}, assignments: [], events: {}, everyday: {},
    consent: {}, settings: {}, answers: {}, actionsDone: {}, recoDismissed: {}, appointments: [], sessions: {},
  };
  for (const [id, name, events] of [[1, "Lotte Peeters", LOTTE_EVENTS], [2, "Jonas Maes", JONAS_EVENTS]]) {
    data.customers[id] = { id, name, kateCoins: 340, convertedEurCents: 0 };
    data.events[id] = events.map(([age, source, kind]) => ({ age, source, kind }));
    data.everyday[id] = EVERYDAY.map(([label, cents]) => ({ label, cents }));
    data.settings[id] = { kateCoinsRecos: true };
  }
  const users = [[1, "lotte", "customer", "Lotte", 1], [2, "jonas", "customer", "Jonas", 2],
    [3, "sofie", "advisor", "Sofie", null], [4, "marc", "advisor", "Marc", null]];
  for (const [id, username, role, displayName, customerId] of users) {
    const { hash, salt } = hashPassword(demoPassword(username));
    data.users[username] = { id, username, role, displayName, customerId, hash, salt };
  }
  data.assignments = [{ advisorId: 3, customerId: 1 }, { advisorId: 4, customerId: 2 }];
  return data;
}

export class Store {
  constructor(file) {
    this.file = file;
    if (fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    else { this.data = seed(); this.save(); }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file); // atomic replace
  }
  userById(id) { return Object.values(this.data.users).find(u => u.id === id) || null; }
}

export const key = (customerId, momentId, extra) => [customerId, momentId, extra].filter(v => v !== undefined).join(":");
