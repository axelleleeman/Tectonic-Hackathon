# Moments – life-moment engine for KBC (Tectonic Hackathon)

KBC recognises life moments (first job, moving in, buying a home, baby, divorce, job loss,
self-employed, sudden large sum, retirement) and responds at the right time, through the right
channel, with an explanation. All data is fictional and synthetic.

## How it works

- **Backend (Node.js + Express)**: detects life moments on the server from categorised
  transactions, in-app behaviour and customer data, within the customer's consent.
- **Decision**: at ≥ 45% confidence the customer is asked first; KBC only acts after "Yes".
  When things get worse (job loss, divorce) KBC only asks an open question:
  "Has something changed in your life?".
- **Frontend**: plain HTML/CSS/JS in `frontend/`, served by the backend. It only shows what the API returns.
- **Kate Coins**: partner recommendations per moment, closed by default, can be dismissed,
  not shown for sensitive moments (except divorce, with practical partners).
- **Data**: a small JSON file store in `data/db.json`, created with synthetic data at first start.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
# open .env and set DEMO_PASSWORD, e.g. DEMO_PASSWORD=demo123
npm start
```

Open http://localhost:8000 and log in with `lotte` or `jonas` (customers) or `sofie` (advisor),
using your `DEMO_PASSWORD`. Without it, random passwords are printed in the console at first start.

- `npm run dev` restarts automatically when you change code.
- Reset the demo: stop the server, delete `data/db.json`, start again.
- In IntelliJ / WebStorm: open the folder, open `package.json` and click ▶ next to `start`.

## Tests

```bash
npm test
```

19 tests cover authentication, CSRF, authorization, IDOR and business-logic rules.

## Deploy (Google Cloud Run)

```bash
gcloud run deploy moments --source . --region europe-west1 --allow-unauthenticated \
  --set-env-vars DEMO_PASSWORD=<secret>
```

Cloud Run storage is not persistent: fine for a demo; production would use a managed database
and Secret Manager for secrets.

## Security (Aikido)

| Risk | What we do |
|---|---|
| Authentication | scrypt password hashes, constant-time comparison, same error for unknown users, login rate limit (5 attempts / 5 min), random session tokens stored only as a hash, 2-hour expiry, logout invalidates the session, new session on login |
| Session cookie | `HttpOnly`, `Secure`, `SameSite=Strict` |
| CSRF | per-session CSRF token required on every state-changing request |
| IDOR | customer endpoints (`/api/me/...`) never take a customer id: the customer always comes from the session |
| Authorization | roles `customer` / `advisor`; advisors only see customers assigned to them (404 otherwise) |
| Business logic | the server re-checks every action: you can only confirm the moment detected at that age, act or book only after confirming, one appointment per moment, only listed time slots, Kate Coins convert once, consent is applied during detection |
| Input validation | unknown fields rejected, whitelists for moment ids, slots and consent categories, bounded ages, 10 kB body limit, no prototype-pollution keys |
| XSS | all dynamic values escaped in the frontend; strict Content-Security-Policy without inline scripts or styles |
| Headers | CSP, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, no `X-Powered-By`, no-store on the API |
| Secrets | no passwords or keys in the code; `.env` is git-ignored, see `.env.example` |
| Errors | generic error messages, no stack traces to the client |

## Not finished / demo simplifications

- The age slider simulates time for the demo; in production detection runs on live data.
- Figures on the scale dashboard are synthetic.
- Partner offers, coin amounts and the coin conversion rate are illustrative.
- The language model (Gemini) for writing messages is described but not connected.
- The JSON file store is for the demo; production would use a real database.
