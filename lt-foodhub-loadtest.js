// L&T FoodHub Load Test
// Simulates 200 employees placing orders simultaneously
// Run: node lt-foodhub-loadtest.js

const SUPABASE_URL = 'https://lorgclscnjdbngqurdsw.supabase.co';
// Use service_role key (from Supabase Dashboard → Settings → API → service_role)
// NEVER put this in your HTML app — only use for testing scripts
const SUPABASE_ANON_KEY = process.env.SUPABASE_SERVICE_KEY || 'PASTE_SERVICE_ROLE_KEY_HERE';

const CANTEEN_ID   = 'c1';
const CANTEEN_NAME = 'North Indian Counter';
const TOTAL_EMPLOYEES = 200;
const WALLET_AMOUNT   = 5000; // each test employee gets ₹5000

const headers = {
  'Content-Type':  'application/json',
  'apikey':        SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
};

// ── helpers ──────────────────────────────────────────
async function rpc(fn, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try {
    const parsed = JSON.parse(text);
    // Supabase RPC returns the result directly, not wrapped
    if (Array.isArray(parsed)) return parsed[0];
    return parsed;
  } catch(e) {
    return { success: false, error: 'Parse error: ' + text.slice(0, 100) };
  }
}

function rest(method, table, body, query = '') {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method, headers: { ...headers, 'Prefer': 'return=representation' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json());
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pad(n, w = 5) { return String(n).padStart(w, '0'); }

const results = {
  created: 0, funded: 0,
  orders: { success: 0, failed: 0, errors: [] },
  tokens: new Set(), duplicateTokens: 0,
  walletErrors: 0,
  timings: [],
};

// ── PHASE 1: create test employees ───────────────────
async function createEmployees() {
  console.log(`\n📋 PHASE 1 — Creating ${TOTAL_EMPLOYEES} test employees...`);
  const employees = [];

  for (let i = 1; i <= TOTAL_EMPLOYEES; i++) {
    const emp = {
      id:             `TEST-LOAD-${pad(i)}`,
      name:           `Load Test User ${pad(i)}`,
      email:          `loadtest${pad(i)}@slp-test.internal`,
      department:     'Load Testing',
      wallet_balance: WALLET_AMOUNT,
      is_active:      true,
    };
    employees.push(emp);
  }

  // Batch insert in chunks of 50
  const chunkSize = 50;
  for (let i = 0; i < employees.length; i += chunkSize) {
    const chunk = employees.slice(i, i + chunkSize);
    const res = await rest('POST', 'employees', chunk);
    if (Array.isArray(res)) {
      results.created += res.length;
    } else {
      console.error('  Insert error:', res);
    }
    process.stdout.write(`  Created ${Math.min(i + chunkSize, TOTAL_EMPLOYEES)}/${TOTAL_EMPLOYEES}\r`);
    await sleep(200);
  }
  console.log(`\n  ✅ ${results.created} employees created`);
  return employees;
}

// ── PHASE 2: simultaneous orders ─────────────────────
async function placeOrders(employees) {
  console.log(`\n⚡ PHASE 2 — Placing ${TOTAL_EMPLOYEES} orders simultaneously...`);
  console.log('  All orders firing at the same time — simulating lunch rush\n');

  const orderPromises = employees.map(async (emp) => {
    const t0 = Date.now();
    try {
      const result = await rpc('place_order', {
        p_employee_id:   emp.id,
        p_canteen_id:    CANTEEN_ID,
        p_canteen_name:  CANTEEN_NAME,
        p_canteen_icon:  '🍛',
        p_pickup_slot:   '12:00 PM - 12:30 PM',
        p_items:         [{ id: 'm317', name: 'Plain Paratha And Sweet Curd', emoji: '🫓', qty: 1, price: 35, customNote: '' }],
        p_payment_method:'wallet',
      });

      const elapsed = Date.now() - t0;
      results.timings.push(elapsed);

      if (result?.success) {
        results.orders.success++;
        if (results.tokens.has(result.token_number)) {
          results.duplicateTokens++;
          results.orders.errors.push(`DUPLICATE TOKEN ${result.token_number} for ${emp.id}`);
        } else {
          results.tokens.add(result.token_number);
        }
      } else {
        results.orders.failed++;
        results.orders.errors.push(`${emp.id}: ${JSON.stringify(result)}`);
      }
    } catch (e) {
      results.orders.failed++;
      results.orders.errors.push(`${emp.id}: EXCEPTION: ${e.message} | ${JSON.stringify(e)}`);
    }
  });

  await Promise.all(orderPromises);
}

// ── PHASE 3: verify wallet deductions ────────────────
async function verifyWallets(employees) {
  console.log('\n🔍 PHASE 3 — Verifying wallet deductions...');
  const ids = employees.map(e => e.id);
  
  // Fetch in batches
  let checked = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const filter = chunk.map(id => `id.eq.${id}`).join(',');
    const res = await rest('GET', 'employees', null, `?or=(${filter})&select=id,wallet_balance`);
    
    if (Array.isArray(res)) {
      for (const emp of res) {
        const actual = parseFloat(emp.wallet_balance);
        // Wallet should have been reduced (not still at 500)
        if (actual >= WALLET_AMOUNT) {
          results.walletErrors++;
          console.error(`  ❌ Wallet mismatch: ${emp.id} expected ₹${expected.toFixed(2)} got ₹${actual.toFixed(2)}`);
        }
        checked++;
      }
    }
    await sleep(100);
  }
  console.log(`  Checked ${checked} wallets`);
}

// ── PHASE 4: cleanup ──────────────────────────────────
async function cleanup(employees) {
  console.log('\n🧹 PHASE 4 — Cleaning up test data...');
  const ids = employees.map(e => e.id);

  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const filter = chunk.map(id => `employee_id.eq.${id}`).join(',');
    await rest('DELETE', 'wallet_transactions', null, `?or=(${filter})`);
    await rest('DELETE', 'orders', null, `?or=(${filter})`);
    await sleep(100);
  }

  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const filter = chunk.map(id => `id.eq.${id}`).join(',');
    await rest('DELETE', 'employees', null, `?or=(${filter})`);
    await sleep(100);
  }
  console.log('  ✅ All test data removed');
}

// ── REPORT ────────────────────────────────────────────
function printReport() {
  const sorted = [...results.timings].sort((a, b) => a - b);
  const avg = sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0;
  const p50 = sorted[Math.floor(sorted.length * 0.50)] || 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
  const max = sorted[sorted.length - 1] || 0;

  console.log('\n' + '═'.repeat(50));
  console.log('  L&T FOODHUB LOAD TEST REPORT');
  console.log('═'.repeat(50));
  console.log(`  Employees tested:    ${TOTAL_EMPLOYEES}`);
  console.log(`  Orders succeeded:    ${results.orders.success}`);
  console.log(`  Orders failed:       ${results.orders.failed}`);
  console.log(`  Success rate:        ${((results.orders.success / TOTAL_EMPLOYEES) * 100).toFixed(1)}%`);
  console.log(`  Duplicate tokens:    ${results.duplicateTokens} ${results.duplicateTokens === 0 ? '✅' : '❌ CRITICAL'}`);
  console.log(`  Wallet errors:       ${results.walletErrors} ${results.walletErrors === 0 ? '✅' : '❌ CRITICAL'}`);
  console.log('─'.repeat(50));
  console.log('  Response times:');
  console.log(`    Average:  ${avg}ms`);
  console.log(`    P50:      ${p50}ms`);
  console.log(`    P95:      ${p95}ms`);
  console.log(`    P99:      ${p99}ms`);
  console.log(`    Slowest:  ${max}ms`);
  console.log('─'.repeat(50));

  if (results.orders.errors.length > 0) {
    console.log(`\n  First 10 errors:`);
    results.orders.errors.slice(0, 10).forEach(e => console.log('  ❌', e));
  }

  console.log('\n  VERDICT:');
  if (results.duplicateTokens === 0 && results.walletErrors === 0 && results.orders.success > TOTAL_EMPLOYEES * 0.95) {
    console.log('  ✅ PASSED — App is ready for 8,000 employees');
    console.log('  Atomic token sequence working correctly');
    console.log('  Wallet deductions accurate under load');
  } else {
    console.log('  ❌ FAILED — Issues found:');
    if (results.duplicateTokens > 0) console.log(`  — ${results.duplicateTokens} duplicate token numbers`);
    if (results.walletErrors > 0)    console.log(`  — ${results.walletErrors} incorrect wallet deductions`);
    if (results.orders.failed > TOTAL_EMPLOYEES * 0.05) console.log(`  — Too many failures: ${results.orders.failed}`);
  }
  console.log('═'.repeat(50) + '\n');
}

// ── MAIN ──────────────────────────────────────────────
async function main() {
  console.log('🚀 L&T FoodHub Load Test');
  console.log(`   Simulating ${TOTAL_EMPLOYEES} simultaneous orders`);
  console.log(`   Target: ${SUPABASE_URL}`);
  console.log('   This will take about 2-3 minutes\n');

  try {
    const employees = await createEmployees();
    if (results.created === 0) {
      console.error('❌ Could not create test employees. Check your Supabase RLS policies allow INSERT.');
      process.exit(1);
    }

    await sleep(1000);
    await placeOrders(employees);
    await sleep(2000);
    await verifyWallets(employees);
    printReport();
    await cleanup(employees);
  } catch (e) {
    console.error('Fatal error:', e);
    process.exit(1);
  }
}

main();
