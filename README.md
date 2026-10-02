# ev-optimiser

Cloudflare Worker that dumps surplus FoxESS home-battery energy into a Tesla
Model Y each morning, protects a house reserve until a free 11:00–14:00 grid
window, and charges the car free during the window if it's still home.

Full design, control logic, and failure-mode analysis: **SPEC.md**. Project
rules for Claude Code: **CLAUDE.md**.

## How it works

A 5-minute cron tick reads the car (Tessie API) and the inverter (FoxESS Open
API), runs a pure state machine (`src/tick.ts`), and executes the resulting
car commands — the inverter is never written to. The FoxESS `minSocOnGrid`
floor and the car's own charge limit are the hardware backstops; every
failure mode degrades to "slightly suboptimal", never a flat house battery.
Decisions are logged to D1 with the inputs they acted on.

## Configuration

Three layers, least to most dynamic:

1. **`src/constants.ts`** — hardware facts and control-loop tuning (battery
   size, charger amps, free-window times, UTC offset, import/export
   thresholds). Edit and redeploy. A fork adapts here first.
2. **D1 `config` table** — runtime settings, no redeploy needed:
   `home_lat`/`home_lon` (geofence, required), `shadow_mode` (default on:
   decisions are logged but no car commands are sent until set to `'false'`),
   `safety_factor`, `stranded_min_pct`, `solar_track`.
3. **Secrets** — `TESSIE_TOKEN`, `TESSIE_VIN`, `FOXESS_API_KEY`,
   `FOXESS_DEVICE_SN`, `NTFY_TOPIC` (alerts), `ADMIN_KEY` (admin HTTP
   routes). Via `wrangler secret put`; local copies in `.dev.vars`.

The cron schedules in `wrangler.jsonc` are expressed in UTC — if you change
the timezone or windows in `constants.ts`, adjust them to match.

## Setup (fresh environment)

The repo is pnpm-managed — do not `npm install`.

```bash
pnpm install
npx wrangler d1 create ev_optimiser        # paste id into wrangler.jsonc
pnpm run migrate
cp .dev.vars.example .dev.vars             # fill in local secrets
npx wrangler secret put TESSIE_TOKEN       # repeat for each secret
npx wrangler d1 execute ev_optimiser --remote \
  --command "INSERT INTO config (key, value) VALUES ('home_lat','<lat>'), ('home_lon','<lon>')"
pnpm run dev
# trigger the nightly pull locally:
curl "http://localhost:8787/__scheduled?cron=0+15+*+*+*"
pnpm test
```

Merging to `main` deploys automatically (`.github/workflows/ci-deploy.yml`:
tests + typecheck, then D1 migrations, then `wrangler deploy`). It needs two
repo secrets, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; PRs run
the tests only. `pnpm run deploy` still works for a manual deploy. Leave `shadow_mode` on and watch the
`decisions` table for a few days before flipping it to `'false'`.
