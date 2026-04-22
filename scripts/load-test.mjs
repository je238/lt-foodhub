#!/usr/bin/env node
// Load test for place_order RPC + monitoring probe
//
// Usage:
//   export SUPABASE_URL=https://lorgclscnjdbngqurdsw.supabase.co
//   export ANON_KEY=<anon key from client>
//   export SERVICE_ROLE_KEY=<service role key from Supabase dashboard>
//   node scripts/load-test.mjs seed <count>       # create N fake employees
//   node scripts/load-test.mjs run <count> [concurrency]   # fire place_order calls
//   node scripts/load-test.mjs cleanup            # delete all loadtest-* employees
//   node scripts/load-test.mjs health             # one-shot RPC probe + latency
//
// Why it's designed this way:
//   - Uses native fetch (Node 20+) so no npm install is needed.
//   - Seeds a distinct loadtest-<n> employee ID prefix so cleanup is easy
//     and we never touch real employees.
//   - Service role is used ONLY for seed/cleanup (writing employees +
//     setting wallet balance); the actual load uses the anon key so we
//     exercise the same policy stack real clients hit.
//   - Reports p50/p95/p99 latency and categorised errors so you can
//     tell "RPC is slow" apart from "RPC is broken".

const { SUPABASE_URL, ANON_KEY, SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error("Missing SUPABASE_URL and/or ANON_KEY env vars");
  process.exit(1);
}

const REST = SUPABASE_URL.replace(/\/$/, "") + "/rest/v1";
const PREFIX = "loadtest-";
const SEED_BALANCE = 5000;       // rupees per test employee
const TEST_CANTEEN_ID = "c1";    // adjust if your test DB differs
const TEST_CANTEEN_NAME = "North Indian Counter";
const TEST_CANTEEN_ICON = "🍛";
const TEST_ITEM = { id: "m37", name: "Load Test Item", emoji: "🍛", qty: 1, price: 60 };
const ORDER_SLOT = "12:00-12:30";

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

function authHeaders(role = "anon") {
  // Anon can INSERT into employees (employees_insert has no WITH CHECK),
  // so seeding works with just ANON_KEY. Cleanup needs service_role since
  // there's no permissive DELETE policy — fall back gracefully when it's
  // absent (script tells the user to clean up via SQL editor).
  const key = role === "service" && SERVICE_ROLE_KEY ? SERVICE_ROLE_KEY : ANON_KEY;
  return {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
    Prefer: "return=minimal"
  };
}

async function rpc(fn, body, { role = "anon" } = {}) {
  const start = Date.now();
  const res = await fetch(`${REST}/rpc/${fn}`, {
    method: "POST",
    headers: { ...authHeaders(role), Prefer: "return=representation" },
    body: JSON.stringify(body)
  });
  const elapsed = Date.now() - start;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { ok: res.ok, status: res.status, elapsed, body: json, raw: text };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

// ────────────────────────────────────────────────────────
// Seed
// ────────────────────────────────────────────────────────

async function seed(count) {
  console.log(`Seeding ${count} test employees (${PREFIX}001..${PREFIX}${String(count).padStart(3, "0")})...`);

  const rows = [];
  for (let i = 1; i <= count; i++) {
    const id = `${PREFIX}${String(i).padStart(3, "0")}`;
    rows.push({
      id,
      name: `Load Test ${i}`,
      email: `${id}@loadtest.invalid`,
      wallet_balance: SEED_BALANCE,
      is_active: true,
      role: "employee",
      initials: "LT"
    });
  }

  // Plain INSERT in batches. We do NOT use merge-duplicates because
  // that triggers an UPDATE on conflict, and employees has a blanket
  // "Block direct updates" policy (USING false) that rejects all UPDATEs
  // from anon. Clean up beforehand with `cleanup` if you're re-running.
  const batchSize = 100;
  let seeded = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const res = await fetch(`${REST}/employees`, {
      method: "POST",
      headers: authHeaders("service"),
      body: JSON.stringify(batch)
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error(`\nSeed batch ${i}-${i + batchSize} failed:`, res.status, txt);
      // If it's a duplicate conflict, the row probably already exists from
      // a prior run — carry on and the test will still hit it.
      if (!txt.includes("duplicate") && !txt.includes("unique")) process.exit(1);
    } else {
      seeded += batch.length;
    }
    process.stdout.write(`  seeded ${Math.min(i + batchSize, rows.length)}/${rows.length}\r`);
  }
  console.log(`\n✓ ${seeded}/${count} test employees ready (balance ₹${SEED_BALANCE} each)`);
}

// ────────────────────────────────────────────────────────
// Run
// ────────────────────────────────────────────────────────

async function run(count, concurrency = 50) {
  console.log(`Firing ${count} place_order calls @ concurrency ${concurrency}...`);
  const results = [];
  let inflight = 0;
  let next = 1;
  let done = 0;

  return new Promise(resolve => {
    const tick = async () => {
      while (inflight < concurrency && next <= count) {
        const n = next++;
        inflight++;
        const id = `${PREFIX}${String(n).padStart(3, "0")}`;
        const start = Date.now();
        rpc("place_order", {
          p_employee_id: id,
          p_canteen_id: TEST_CANTEEN_ID,
          p_canteen_name: TEST_CANTEEN_NAME,
          p_canteen_icon: TEST_CANTEEN_ICON,
          p_pickup_slot: ORDER_SLOT,
          p_items: [TEST_ITEM],
          p_payment_method: "wallet"
        }).then(r => {
          results.push({ id, ...r });
          inflight--;
          done++;
          if (done % 50 === 0 || done === count) {
            process.stdout.write(`  ${done}/${count} done\r`);
          }
          if (done === count) {
            console.log();
            resolve(report(results));
          } else {
            tick();
          }
        });
      }
    };
    tick();
  });
}

function report(results) {
  const ok = results.filter(r => r.ok && r.body?.success !== false);
  const httpErr = results.filter(r => !r.ok);
  const logicErr = results.filter(r => r.ok && r.body?.success === false);
  const latencies = results.map(r => r.elapsed).sort((a, b) => a - b);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Total:       ${results.length}`);
  console.log(`Success:     ${ok.length}  (${((ok.length / results.length) * 100).toFixed(1)}%)`);
  console.log(`HTTP error:  ${httpErr.length}`);
  console.log(`Logic error: ${logicErr.length}  (RPC returned success:false)`);
  console.log("\nLatency (ms):");
  console.log(`  min:  ${latencies[0]}`);
  console.log(`  p50:  ${percentile(latencies, 50)}`);
  console.log(`  p95:  ${percentile(latencies, 95)}`);
  console.log(`  p99:  ${percentile(latencies, 99)}`);
  console.log(`  max:  ${latencies[latencies.length - 1]}`);

  if (logicErr.length > 0) {
    console.log("\nLogic error samples (first 5):");
    logicErr.slice(0, 5).forEach(e => {
      console.log(`  ${e.id}: ${JSON.stringify(e.body?.error || e.body)}`);
    });
  }
  if (httpErr.length > 0) {
    console.log("\nHTTP error samples (first 5):");
    httpErr.slice(0, 5).forEach(e => {
      console.log(`  ${e.id}: ${e.status} — ${e.raw.slice(0, 200)}`);
    });
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  return { ok: ok.length, httpErr: httpErr.length, logicErr: logicErr.length, latencies };
}

// ────────────────────────────────────────────────────────
// Cleanup
// ────────────────────────────────────────────────────────

async function cleanup() {
  if (!SERVICE_ROLE_KEY) throw new Error("SERVICE_ROLE_KEY required");
  console.log(`Cleaning up ${PREFIX}* employees, their orders + wallet txns...`);

  // Order of deletes matters if there are FK constraints:
  //   order_items → orders → (employees, wallet_transactions) →
  await fetch(`${REST}/order_items?order_id=in.(select%20id%20from%20orders%20where%20employee_id%20like%20${encodeURIComponent(PREFIX)}%25)`, {
    method: "DELETE", headers: authHeaders("service")
  }).catch(() => {}); // This URL style may not work; doing explicit two-step below instead.

  // Fetch ids first, then delete each table.
  const idsRes = await fetch(`${REST}/orders?select=id&employee_id=like.${encodeURIComponent(PREFIX)}*`, {
    headers: authHeaders("service")
  });
  const orders = idsRes.ok ? await idsRes.json() : [];
  if (orders.length) {
    const inList = orders.map(o => o.id).join(",");
    await fetch(`${REST}/order_items?order_id=in.(${inList})`, { method: "DELETE", headers: authHeaders("service") });
    await fetch(`${REST}/orders?id=in.(${inList})`, { method: "DELETE", headers: authHeaders("service") });
    console.log(`  deleted ${orders.length} orders + their items`);
  }

  await fetch(`${REST}/wallet_transactions?employee_id=like.${encodeURIComponent(PREFIX)}*`, {
    method: "DELETE", headers: authHeaders("service")
  });

  const res = await fetch(`${REST}/employees?id=like.${encodeURIComponent(PREFIX)}*`, {
    method: "DELETE", headers: authHeaders("service")
  });
  console.log(`✓ cleanup complete (${res.status})`);
}

// ────────────────────────────────────────────────────────
// Health probe (single RPC hit, measure latency)
// ────────────────────────────────────────────────────────

async function health() {
  // Use employee_account_status as a low-impact read probe.
  const r = await rpc("employee_account_status", { p_email: "probe@loadtest.invalid" });
  const status = r.ok ? "UP" : "DOWN";
  console.log(JSON.stringify({
    status,
    http: r.status,
    latency_ms: r.elapsed,
    body: r.body,
    ts: new Date().toISOString()
  }));
  process.exit(r.ok ? 0 : 1);
}

// ────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────

const [, , cmd, arg1, arg2] = process.argv;
try {
  if (cmd === "seed") await seed(parseInt(arg1 || "100", 10));
  else if (cmd === "run") await run(parseInt(arg1 || "100", 10), parseInt(arg2 || "50", 10));
  else if (cmd === "cleanup") await cleanup();
  else if (cmd === "health") await health();
  else {
    console.error("Usage: load-test.mjs seed|run|cleanup|health [args]");
    process.exit(1);
  }
} catch (e) {
  console.error("FATAL:", e.message);
  process.exit(1);
}
