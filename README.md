# sodax-tick-keeper

AWS Lambda keeper for Sodax `LeverageYieldVault`s on Sonic. Polls each registered vault's
position; if LTV drifts outside the configured tolerance band, calls `tick()` to rebalance
and POSTs the resulting tx hash to the Sodax solver to nudge intent fill.

Multi-vault by design — iterates the registry in [`src/config.ts`](src/config.ts) and
processes each vault independently. One vault's revert never blocks another.

## Layout

```
sodax-tick-keeper/
├── src/
│   ├── handler.ts     # AWS Lambda entry + local CLI entry
│   ├── keeper.ts      # core: assess → tick → notify-solver
│   ├── solver.ts      # POST tx hash to the Sodax solver
│   └── config.ts      # vault registry + env loading
├── serverless.yml     # Serverless Framework deployment manifest
├── package.json
├── tsconfig.json
└── .env.example
```

## What it does, per pass

For every vault in the registry:

1. Read `getPositionDetails()`, `targetLTV()`, `ltvTolerance()`.
2. `deviation = |currentLTV - targetLTV|`. If `deviation > tolerance`, the vault is
   out of band → continue. Otherwise log "skipped: within-tolerance" and move on.
3. Simulate `tick()` (catches reverts — e.g. health factor too tight to lever up — without
   spending gas).
4. Submit `tick()`, wait for receipt.
5. Decode events. If a `Leveraged` event is present (lever-up created a swap intent),
   POST the tx hash to `<SOLVER_API_URL>/execute` so the solver picks it up
   immediately instead of waiting for its indexer to catch the on-chain event.

All logs are structured JSON to stdout — CloudWatch ingests them as queryable fields.

## Configure

Copy `.env.example` to `.env` and fill in:

| Var | Required | Default | Notes |
|---|---|---|---|
| `PRIVATE_KEY` | yes | — | Funded EVM key on Sonic. Hot key, holds ~10–50 S for fees only. |
| `SONIC_RPC` | no | `https://rpc.soniclabs.com` | Use a private provider for production cadence. |
| `SOLVER_API_URL` | no | `https://api.sodax.com` | Set to `https://api.sodax-staging.com` for staging. |
| `VAULTS` | no | (built-in registry) | Comma-separated addresses to override the registry. Useful for testnet vaults. |
| `TICK_TIMEOUT_MS` | no | `60000` | Per-vault `waitForTransactionReceipt` timeout. Must parse to a positive integer or cold-start throws. |
| `DRY_RUN` | no | (off) | `1`/`true`/`yes` → assess + log every vault but never send `tick()`. Use for a safe first run. |

To add a production vault, edit `REGISTRY` in [`src/config.ts`](src/config.ts) — keep it
aligned with `@sodax/types`'s `leverageYieldVaults` constant.

## Run locally

```bash
pnpm install            # or npm install
cp .env.example .env    # fill in PRIVATE_KEY
pnpm run once           # one full pass over every vault, then exit
pnpm run loop 60        # repeat every 60 s (Ctrl-C to stop)
```

`pnpm run lint` runs `tsc --noEmit`. `pnpm run build` produces `dist/`.

## Deploy to AWS Lambda

### Option A — Serverless Framework (recommended)

```bash
npm install -g serverless
pnpm install
pnpm run build
PRIVATE_KEY=0x... npx serverless deploy
```

EventBridge rule: every 5 minutes (configurable in `serverless.yml`). Memory: 256 MB.
Timeout: 5 min. Logs retained 30 days.

For staging: `npx serverless deploy --stage staging` and adjust env vars accordingly.

### Option B — Manual zip-and-upload

```bash
pnpm install --prod
pnpm run build
zip -r sodax-tick-keeper.zip dist node_modules
# Upload sodax-tick-keeper.zip via AWS Console or:
aws lambda create-function \
  --function-name sodax-tick-keeper \
  --runtime nodejs20.x \
  --architectures arm64 \
  --handler dist/handler.handler \
  --memory-size 256 \
  --timeout 300 \
  --role arn:aws:iam::<ACCOUNT>:role/<ROLE_WITH_BASIC_LAMBDA_EXECUTION> \
  --zip-file fileb://sodax-tick-keeper.zip \
  --environment Variables="{PRIVATE_KEY=0x...,SONIC_RPC=https://rpc.soniclabs.com,SOLVER_API_URL=https://api.sodax.com}"
```

Then attach a CloudWatch / EventBridge schedule:

```bash
aws events put-rule --name sodax-tick-keeper-5min --schedule-expression 'rate(5 minutes)'
aws events put-targets --rule sodax-tick-keeper-5min \
  --targets "Id=1,Arn=arn:aws:lambda:<REGION>:<ACCOUNT>:function:sodax-tick-keeper"
aws lambda add-permission --function-name sodax-tick-keeper \
  --statement-id sodax-tick-keeper-eventbridge \
  --action lambda:InvokeFunction --principal events.amazonaws.com \
  --source-arn arn:aws:events:<REGION>:<ACCOUNT>:rule/sodax-tick-keeper-5min
```

## Secret management (production)

For a real production deployment, **don't** put `PRIVATE_KEY` in plain Lambda env vars.
Use AWS Secrets Manager and reference it from `serverless.yml`:

```yaml
provider:
  environment:
    PRIVATE_KEY: ${ssm:/sodax/keeper/private-key}
```

## Observability

Each vault pass emits 2–3 JSON log lines to CloudWatch — easy to query with Logs Insights:

```
fields @timestamp, vault, msg, kind, currentLTV, targetLTV, deviation, txHash
| filter msg = "tick-outcome"
| sort @timestamp desc
| limit 50
```

Per-vault failures are isolated and logged, so a single vault erroring does **not** fail the
invocation. The handler only rethrows (→ a CloudWatch **Errors** invocation) on a *systemic*
failure — when **every** vault hits an infrastructure error (`kind: "errored"`, e.g. the RPC
is down). This distinguishes "the keeper can't run" from "one vault is paused".

Outcome vocabulary in the logs:
- `kind: "ticked"` — tick sent (see `eventName`, `txHash`).
- `kind: "skipped"` — `reason: "within-tolerance"` (no-op) or `"dry-run"` (DRY_RUN on).
- `kind: "reverted"` — `tick()` simulation reverted on-chain (HF floor, paused) — **expected**.
- `kind: "errored"` — RPC/unexpected failure — **the signal worth investigating**.

Recommended CloudWatch alarms:
- **Errors metric > 0** in any 15-min window → systemic failure (all vaults errored, bad config,
  unfunded/invalid key). Now fires reliably because the handler rethrows on it.
- **Logs metric filter on `{ $.level = "error" }`** → catches *partial* failures (one vault's RPC
  blip) that don't fail the invocation. Alarm if sustained across several passes.
- **Duration > 60 s** → RPC degradation, raise.
- **`level=warn` count** (filter on `kind = "reverted"`) → tick simulation fails. Investigate
  whether vault state is stuck (HF too low to lever up) — low priority, often expected.

## Operational notes

- **`tick()` is idempotent** when LTV is inside the band — the contract just no-ops. Safe
  to over-call.
- **Lever-up is single-step**: each tick brings LTV closer to target asymptotically. After
  a target change you'll see 6–10 ticks settle near the new target.
- **Deleverage hits target in one tick** — instant.
- **HF floor**: `_beforeLeverageUp` refuses any step that would drop HF below `minHealthFactor`.
  When the vault is paused or close to its HF floor, simulations revert and the keeper logs
  `kind: "reverted"` — that's expected, not an alert worth paging on.
- **Solver POST is best-effort**: a 5xx from the solver is logged but doesn't block the next
  vault. The solver still has its own indexer.

## Testing

No unit tests yet (the logic is mostly RPC + viem calls — best validated with a forked-Sonic
integration test). For now, the safe first-run check:

```bash
DRY_RUN=1 pnpm run once    # reads every vault, logs needsRebalance, sends NO transactions
```

Inspect the `assess` lines — confirm each vault returns sane `targetLTV` / `currentLTV` /
`deviation` — then drop `DRY_RUN` to go live. The deploy honors `DRY_RUN` too (set it in the
environment), so you can ship in read-only mode first and flip it off once logs look right.

## Related

- SDK: `@sodax/sdk` → `LeverageYieldService` (cross-chain deposit / withdraw).
- Vault registry source of truth: `@sodax/types` → `leverageYieldVaults`.
- Test harness: `leverage-yield-test/` (vault.js + backend.js — predecessor of this keeper).
