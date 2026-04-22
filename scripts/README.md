# Ship-readiness scripts

Load test and health probe for the 7,000-user rollout.

## One-time setup

Get your Supabase keys:
- `ANON_KEY` — already public in `index.html` (the `SKEY` constant)
- `SERVICE_ROLE_KEY` — Supabase dashboard → Project Settings → API → `service_role` key (secret — never commit)

```bash
export SUPABASE_URL="https://lorgclscnjdbngqurdsw.supabase.co"
export ANON_KEY="<anon key from index.html line ~4849>"
export SERVICE_ROLE_KEY="<service_role from Supabase dashboard>"
```

## Load test workflow (run once before Apr 25)

```bash
# 1. Seed 500 test employees with ₹5000 wallet balance each
node scripts/load-test.mjs seed 500

# 2. Fire 500 concurrent place_order calls
node scripts/load-test.mjs run 500 100    # 500 total, 100 concurrent

# 3. Clean up test employees + their orders
node scripts/load-test.mjs cleanup
```

**What to watch for in the output:**

- **Success rate < 99%** — something's wrong. Look at the logic error samples printed at the end.
- **p95 > 3000ms** — the RPC is too slow under load. Check Supabase dashboard → Database → Query Performance.
- **HTTP 503 / 504** — pooler connection limit hit. Supabase Pro has ~15 connections by default; may need to upgrade the pool or enable prepared statements.
- **Logic error: `INSUFFICIENT_BALANCE`** — expected if you don't seed enough balance; bump `SEED_BALANCE` in the script.
- **Logic error: `TOKEN_COLLISION` or similar** — race condition in `place_order` at high concurrency. This is the scariest one — tell me if it happens.

Recommended runs (escalate gradually):
```
run 50 10     # smoke test
run 500 100   # realistic lunch peak
run 2000 200  # stress test — simulate the whole campus hitting order button at once
```

## Health probe

Single-call probe for external uptime monitors:

```bash
node scripts/load-test.mjs health
```

Exits 0 if the `employee_account_status` RPC returns 2xx, non-zero otherwise. JSON on stdout for log scraping.

### Hooking this to a free uptime monitor

[UptimeRobot](https://uptimerobot.com) or [cron-job.org](https://cron-job.org) — both free:

1. Create a tiny Vercel serverless function that internally calls `employee_account_status` and returns 200/500 based on result. Put it at `/api/health`.
2. Point the uptime monitor at `https://slp-nexus.vercel.app/api/health` with 5-minute interval.
3. Configure alert → email / SMS / Slack webhook.

Simpler alternative: Supabase dashboard → Project Settings → Alerts. Enable email alerts for edge function errors and database issues. This catches most things for free, zero setup.

## Pre-launch checklist (Apr 24 evening)

- [ ] `node load-test.mjs run 500 100` passes with >99% success, p95 < 3s
- [ ] Edge function `icici-payment` invoked at least 5 times in pilot, all succeeded
- [ ] Supabase dashboard → Alerts → enabled for project
- [ ] Rollback playbook written (one page; how to revert web deploy, edge fn, migration)
- [ ] Test admin kill-switch actually disables ICICI end-to-end in the APK
- [ ] Reversed any test wallet credits
- [ ] Someone on-call reachable 11am–2pm on Apr 25
