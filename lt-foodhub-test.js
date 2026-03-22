// ═══════════════════════════════════════════════════
// L&T FoodHub — Automated Health Check
// Run: node lt-foodhub-test.js
// ═══════════════════════════════════════════════════

const SUPABASE_URL = 'https://lorgclscnjdbngqurdsw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || '';

let passed = 0, failed = 0, warnings = 0;

function ok(name)   { console.log(`  ✅ ${name}`); passed++; }
function fail(name, reason) { console.log(`  ❌ ${name}: ${reason}`); failed++; }
function warn(name, reason) { console.log(`  ⚠️  ${name}: ${reason}`); warnings++; }

async function db(path, key, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...opts.headers
    },
    ...opts
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function rpc(fn, body, key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// ── TEST 1: DB connectivity ──────────────────────────
async function testDB() {
  console.log('\n📡 1. Database Connectivity');
  try {
    const { status } = await db('canteens?limit=1', SUPABASE_KEY || SERVICE_KEY);
    if (status === 200) ok('Supabase reachable');
    else fail('Supabase connection', `Status ${status}`);
  } catch(e) { fail('Supabase connection', e.message); }
}

// ── TEST 2: Tables exist ─────────────────────────────
async function testTables() {
  console.log('\n🗄️  2. Critical Tables');
  const tables = ['employees','orders','order_items','menu_items','canteens',
                  'wallet_transactions','email_otps','canteen_token_sequences'];
  for (const t of tables) {
    try {
      const { status } = await db(`${t}?limit=1`, SERVICE_KEY);
      if (status === 200) ok(t);
      else fail(t, `Status ${status}`);
    } catch(e) { fail(t, e.message); }
  }
}

// ── TEST 3: RPC functions exist ──────────────────────
async function testRPCs() {
  console.log('\n⚙️  3. RPC Functions');
  const rpcs = [
    { name: 'place_order', body: {} },
    { name: 'employee_cancel_order', body: {} },
    { name: 'verify_email_otp', body: { p_email: 'test@test.com', p_otp: '000000' } },
  ];
  for (const r of rpcs) {
    try {
      const { status } = await rpc(r.name, r.body, SERVICE_KEY);
      // 400 = function exists but bad params (expected), 404 = missing
      if (status !== 404) ok(r.name);
      else fail(r.name, 'Function not found in DB');
    } catch(e) { fail(r.name, e.message); }
  }
}

// ── TEST 4: Menu items loaded ────────────────────────
async function testMenu() {
  console.log('\n🍽️  4. Menu');
  try {
    const { status, data } = await db('menu_items?select=id,name,price,is_available&limit=200', SERVICE_KEY);
    if (status !== 200) { fail('Menu fetch', `Status ${status}`); return; }
    ok(`${data.length} menu items found`);
    const unavail = data.filter(m => !m.is_available).length;
    if (unavail > 0) warn('Unavailable items', `${unavail} items marked unavailable`);
    const noPrice = data.filter(m => !m.price || m.price <= 0).length;
    if (noPrice > 0) fail('Items with no price', `${noPrice} items have ₹0 price`);
    else ok('All items have valid prices');
  } catch(e) { fail('Menu', e.message); }
}

// ── TEST 5: Canteens open ────────────────────────────
async function testCanteens() {
  console.log('\n🏪 5. Canteens');
  try {
    const { status, data } = await db('canteens?select=id,name,is_open', SERVICE_KEY);
    if (status !== 200) { fail('Canteens fetch', `Status ${status}`); return; }
    ok(`${data.length} canteens found`);
    const open = data.filter(c => c.is_open).length;
    if (open === 0) warn('No canteens open', 'All canteens are closed');
    else ok(`${open} canteens open`);
  } catch(e) { fail('Canteens', e.message); }
}

// ── TEST 6: Token sequences exist for today ──────────
async function testTokens() {
  console.log('\n🎫 6. Token Sequences');
  try {
    const today = new Date().toISOString().slice(0,10);
    const { status, data } = await db(
      `canteen_token_sequences?token_date=eq.${today}`, SERVICE_KEY
    );
    if (status !== 200) { fail('Token sequences', `Status ${status}`); return; }
    if (data.length === 0) warn('Token sequences', 'No sequences for today — will auto-create on first order');
    else ok(`${data.length} token sequences for today`);
  } catch(e) { fail('Token sequences', e.message); }
}

// ── TEST 7: Place order end-to-end ───────────────────
async function testPlaceOrder() {
  console.log('\n🛒 7. Place Order (End-to-End)');
  if (!SERVICE_KEY) { warn('Place order test', 'Needs SUPABASE_SERVICE_KEY — skipping'); return; }

  const testId = 'TEST-HEALTH-' + Date.now();
  try {
    // Create test employee
    await db('employees', SERVICE_KEY, {
      method: 'POST',
      body: JSON.stringify({ id: testId, name: 'Health Check', email: `${testId}@test.internal`, department: 'Test', wallet_balance: 5000, is_active: true })
    });

    // Get real menu item
    const { data: items } = await db('menu_items?is_available=eq.true&limit=1&select=id,name,price,canteen_id', SERVICE_KEY);
    if (!items?.length) { warn('Place order', 'No available menu items to test with'); return; }
    const item = items[0];

    // Get canteen
    const { data: canteens } = await db(`canteens?id=eq.${item.canteen_id}&limit=1`, SERVICE_KEY);
    const canteen = canteens?.[0] || { id: item.canteen_id, name: 'Test Counter', icon: '🍽️' };

    // Place order
    const { data: result } = await rpc('place_order', {
      p_employee_id: testId,
      p_canteen_id: canteen.id,
      p_canteen_name: canteen.name,
      p_canteen_icon: canteen.icon || '🍽️',
      p_pickup_slot: '12:30 PM',
      p_items: [{ id: item.id, name: item.name, emoji: '🍽️', qty: 1, price: item.price }],
      p_payment_method: 'wallet'
    }, SERVICE_KEY);

    if (result?.success) {
      ok(`Order placed — Token #${result.token_number}, Paid ₹${result.amount_paid}`);
      // Verify wallet deducted
      const { data: emp } = await db(`employees?id=eq.${testId}&select=wallet_balance`, SERVICE_KEY);
      const expected = 5000 - parseFloat(result.amount_paid);
      const actual   = parseFloat(emp?.[0]?.wallet_balance);
      if (Math.abs(actual - expected) < 0.01) ok('Wallet deducted correctly');
      else fail('Wallet deduction', `Expected ₹${expected}, got ₹${actual}`);
      // Verify GST charged
      if (parseFloat(result.amount_paid) > item.price) ok('GST + platform fee charged');
      else warn('GST check', 'amount_paid equals item price — GST may not be applied');
    } else {
      fail('Place order RPC', result?.error || 'Unknown error');
    }

    // Cleanup
    await db(`order_items?order_id=in.(${
      (await db(`orders?employee_id=eq.${testId}&select=id`, SERVICE_KEY)).data?.map(o=>o.id).join(',') || 'null'
    })`, SERVICE_KEY, { method: 'DELETE' });
    await db(`orders?employee_id=eq.${testId}`, SERVICE_KEY, { method: 'DELETE' });
    await db(`wallet_transactions?employee_id=eq.${testId}`, SERVICE_KEY, { method: 'DELETE' });
    await db(`employees?id=eq.${testId}`, SERVICE_KEY, { method: 'DELETE' });
    ok('Test data cleaned up');
  } catch(e) {
    fail('Place order', e.message);
    // Cleanup on error
    await db(`orders?employee_id=eq.${testId}`, SERVICE_KEY, { method: 'DELETE' }).catch(()=>{});
    await db(`employees?id=eq.${testId}`, SERVICE_KEY, { method: 'DELETE' }).catch(()=>{});
  }
}

// ── TEST 8: RLS check ────────────────────────────────
async function testRLS() {
  console.log('\n🔒 8. Security (RLS)');
  // Try to read employees without auth — should fail or return empty
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/employees?limit=1`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (res.status === 200) {
      const data = await res.json();
      if (data.length === 0) ok('Employees table — RLS blocking anon reads');
      else warn('Employees RLS', 'Anon key can read employee records — check RLS policies');
    } else {
      ok('Employees table — RLS active');
    }
  } catch(e) { warn('RLS check', e.message); }
}

// ── MAIN ─────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════');
  console.log('   L&T FoodHub — Automated Health Check');
  console.log('═══════════════════════════════════════');

  if (!SERVICE_KEY) {
    console.log('\n⚠️  Run with: SUPABASE_SERVICE_KEY="your_key" node lt-foodhub-test.js');
    console.log('   Some tests will be skipped without the service key.\n');
  }

  await testDB();
  await testTables();
  await testRPCs();
  await testMenu();
  await testCanteens();
  await testTokens();
  await testPlaceOrder();
  await testRLS();

  console.log('\n═══════════════════════════════════════');
  console.log(`   ✅ Passed:   ${passed}`);
  console.log(`   ❌ Failed:   ${failed}`);
  console.log(`   ⚠️  Warnings: ${warnings}`);
  console.log('═══════════════════════════════════════');
  if (failed === 0) console.log('   🚀 ALL CLEAR — safe to deploy');
  else console.log('   🔴 FIX FAILURES BEFORE DEPLOYING');
  console.log('═══════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test runner crashed:', e); process.exit(1); });
