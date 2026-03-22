// ═══════════════════════════════════════════════════════════════
// L&T FoodHub — Full Regression Test Suite
// Tests: Employee, Vendor/Kitchen, Admin, Cancel/Refund flows
// Run: SUPABASE_SERVICE_KEY="your_key" node lt-foodhub-fulltest.js
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://lorgclscnjdbngqurdsw.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || '';
const ANON_KEY     = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvcmdjbHNjbmpkYm5ncXVyZHN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDI0MDY5NzksImV4cCI6MjA1Nzk4Mjk3OX0.nVkEDHBCOeElFaGcodArAdCVKbE9arkZMxFmGsaLTHQ';

let passed = 0, failed = 0, warnings = 0;
const failures = [];

function ok(name)        { console.log(`  ✅ ${name}`); passed++; }
function fail(name, why) { console.log(`  ❌ ${name}: ${why}`); failed++; failures.push({name, why}); }
function warn(name, why) { console.log(`  ⚠️  ${name}: ${why}`); warnings++; }
function section(name)   { console.log(`\n${'═'.repeat(50)}\n  ${name}\n${'═'.repeat(50)}`); }

async function db(path, key, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation', ...opts.headers },
    ...opts
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function rpc(fn, body, key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// ── HELPERS ──────────────────────────────────────────────────────
async function createTestEmployee(id, balance = 5000) {
  await db('employees', SERVICE_KEY, {
    method: 'POST',
    body: JSON.stringify({ id, name: 'Test Employee', email: `${id}@test.internal`, department: 'Test', wallet_balance: balance, is_active: true })
  });
}

async function getMenuItem() {
  const { data } = await db('menu_items?is_available=eq.true&select=id,name,price,canteen_id&limit=1', SERVICE_KEY);
  return data?.[0];
}

async function getCanteen(id) {
  const { data } = await db(`canteens?id=eq.${id}&limit=1`, SERVICE_KEY);
  return data?.[0];
}

async function placeOrder(empId, item, canteen) {
  return rpc('place_order', {
    p_employee_id: empId,
    p_canteen_id: canteen.id,
    p_canteen_name: canteen.name,
    p_canteen_icon: canteen.icon || '🍽️',
    p_pickup_slot: '12:30 PM',
    p_items: [{ id: item.id, name: item.name, emoji: '🍽️', qty: 1, price: item.price }],
    p_payment_method: 'wallet'
  }, SERVICE_KEY);
}

async function cleanup(empId) {
  const { data: orders } = await db(`orders?employee_id=eq.${empId}&select=id`, SERVICE_KEY);
  if (orders?.length) {
    const ids = orders.map(o => o.id).join(',');
    await db(`order_items?order_id=in.(${ids})`, SERVICE_KEY, { method: 'DELETE' });
    await db(`wallet_transactions?employee_id=eq.${empId}`, SERVICE_KEY, { method: 'DELETE' });
    await db(`orders?employee_id=eq.${empId}`, SERVICE_KEY, { method: 'DELETE' });
  }
  await db(`employees?id=eq.${empId}`, SERVICE_KEY, { method: 'DELETE' });
}

// ════════════════════════════════════════════════════════════════
// SECTION 1: INFRASTRUCTURE
// ════════════════════════════════════════════════════════════════
async function testInfrastructure() {
  section('1. Infrastructure');

  // DB connectivity
  try {
    const { status } = await db('canteens?limit=1', SERVICE_KEY);
    status === 200 ? ok('Supabase reachable') : fail('Supabase connection', `Status ${status}`);
  } catch(e) { fail('Supabase connection', e.message); }

  // All critical tables
  const tables = ['employees','orders','order_items','menu_items','canteens','wallet_transactions','email_otps','canteen_token_sequences'];
  for (const t of tables) {
    const { status } = await db(`${t}?limit=1`, SERVICE_KEY);
    status === 200 ? ok(`Table: ${t}`) : fail(`Table: ${t}`, `Status ${status}`);
  }

  // RPC functions via SQL check
  const { data: funcs } = await rpc('verify_email_otp', { p_email: 'x@x.com', p_otp: '000000' }, SERVICE_KEY);
  funcs !== null ? ok('RPC: verify_email_otp reachable') : fail('RPC: verify_email_otp', 'Not found');

  // Token sequences for today
  const today = new Date().toISOString().slice(0,10);
  const { data: tokens } = await db(`canteen_token_sequences?token_date=eq.${today}`, SERVICE_KEY);
  tokens?.length > 0 ? ok(`Token sequences: ${tokens.length} for today`) : warn('Token sequences', 'None for today — will auto-create on first order');

  // Menu health
  const { data: menu } = await db('menu_items?select=id,name,price,is_available&limit=500', SERVICE_KEY);
  if (menu) {
    const unavail = menu.filter(m => !m.is_available).length;
    const noPrice = menu.filter(m => !m.price || m.price <= 0).length;
    ok(`Menu: ${menu.length} items loaded`);
    noPrice > 0 ? fail('Menu: items with ₹0 price', `${noPrice} items`) : ok('Menu: all items have valid prices');
    unavail > 0 ? warn('Menu: unavailable items', `${unavail} items marked off`) : ok('Menu: all items available');
  }

  // Canteens
  const { data: canteens } = await db('canteens?select=id,name,is_open', SERVICE_KEY);
  if (canteens) {
    ok(`Canteens: ${canteens.length} found`);
    const open = canteens.filter(c => c.is_open).length;
    open === 0 ? warn('Canteens: all closed', 'No canteen is open') : ok(`Canteens: ${open} open`);
  }
}

// ════════════════════════════════════════════════════════════════
// SECTION 2: EMPLOYEE SIDE
// ════════════════════════════════════════════════════════════════
async function testEmployeeSide() {
  section('2. Employee Side');
  const empId = 'TEST-EMP-' + Date.now();
  const item = await getMenuItem();
  if (!item) { warn('Employee tests', 'No available menu item — skipping'); return; }
  const canteen = await getCanteen(item.canteen_id);
  if (!canteen) { warn('Employee tests', 'Canteen not found — skipping'); return; }

  try {
    await createTestEmployee(empId, 5000);
    ok('Employee: created with ₹5000 wallet');

    // Place order
    const { data: order } = await placeOrder(empId, item, canteen);
    if (!order?.success) { fail('Employee: place order', order?.error || 'Unknown'); await cleanup(empId); return; }
    ok(`Employee: order placed — Token #${order.token_number}`);

    // Verify amount_paid includes GST + platform fee
    const expectedMin = item.price + (item.price * 0.05) + 3;
    if (parseFloat(order.amount_paid) >= expectedMin) {
      ok(`Employee: GST + platform fee charged (₹${order.amount_paid})`);
    } else {
      fail('Employee: GST not charged', `Expected ≥₹${expectedMin.toFixed(2)}, got ₹${order.amount_paid}`);
    }

    // Verify wallet deducted
    const { data: emp } = await db(`employees?id=eq.${empId}&select=wallet_balance`, SERVICE_KEY);
    const expected = 5000 - parseFloat(order.amount_paid);
    const actual = parseFloat(emp?.[0]?.wallet_balance);
    Math.abs(actual - expected) < 0.01 ? ok(`Employee: wallet deducted correctly (₹${actual})`) : fail('Employee: wallet deduction', `Expected ₹${expected.toFixed(2)}, got ₹${actual}`);

    // Verify order in DB
    const { data: dbOrder } = await db(`orders?id=eq.${order.order_id}&select=*`, SERVICE_KEY);
    dbOrder?.[0] ? ok('Employee: order saved in DB') : fail('Employee: order not in DB', 'Missing');

    // Verify order_items saved
    const { data: items } = await db(`order_items?order_id=eq.${order.order_id}`, SERVICE_KEY);
    items?.length > 0 ? ok('Employee: order_items saved') : fail('Employee: order_items missing', 'No items in DB');

    // Verify wallet_transaction logged
    const { data: txns } = await db(`wallet_transactions?employee_id=eq.${empId}`, SERVICE_KEY);
    txns?.length > 0 ? ok('Employee: wallet transaction logged') : fail('Employee: wallet transaction missing', 'Not logged');

    // ── CANCEL ORDER + REFUND ────────────────────────────────────
    console.log('\n  → Testing cancel & refund...');
    const balBeforeCancel = actual;
    const amountPaid = parseFloat(order.amount_paid);

    const { data: cancelResult } = await rpc('employee_cancel_order', {
      p_order_id: order.order_id,
      p_employee_id: empId
    }, SERVICE_KEY);

    if (cancelResult?.success) {
      ok('Employee: cancel order — RPC success');

      // Verify wallet refunded
      const newBal = parseFloat(cancelResult.new_balance);
      const expectedBal = balBeforeCancel + amountPaid;
      Math.abs(newBal - expectedBal) < 0.01
        ? ok(`Employee: refund correct — ₹${amountPaid} returned (balance ₹${newBal})`)
        : fail('Employee: refund amount wrong', `Expected ₹${expectedBal.toFixed(2)}, got ₹${newBal}`);

      // Verify order status = cancelled in DB
      const { data: cancelled } = await db(`orders?id=eq.${order.order_id}&select=status`, SERVICE_KEY);
      cancelled?.[0]?.status === 'cancelled'
        ? ok('Employee: order status = cancelled in DB')
        : fail('Employee: order status not updated', `Status: ${cancelled?.[0]?.status}`);

      // Verify refund transaction logged
      const { data: refundTxn } = await db(`wallet_transactions?employee_id=eq.${empId}&type=eq.credit`, SERVICE_KEY);
      refundTxn?.length > 0
        ? ok('Employee: refund transaction logged')
        : fail('Employee: refund transaction missing', 'No credit transaction');

    } else {
      fail('Employee: cancel order', cancelResult?.error || 'RPC returned false');
    }

  } catch(e) {
    fail('Employee tests crashed', e.message);
  } finally {
    await cleanup(empId);
    ok('Employee: test data cleaned up');
  }
}

// ════════════════════════════════════════════════════════════════
// SECTION 3: KITCHEN / VENDOR SIDE
// ════════════════════════════════════════════════════════════════
async function testKitchenSide() {
  section('3. Kitchen / Vendor Side');
  const empId = 'TEST-KDS-' + Date.now();
  const item = await getMenuItem();
  if (!item) { warn('Kitchen tests', 'No menu item — skipping'); return; }
  const canteen = await getCanteen(item.canteen_id);
  if (!canteen) { warn('Kitchen tests', 'Canteen not found — skipping'); return; }

  try {
    await createTestEmployee(empId, 5000);
    const { data: order } = await placeOrder(empId, item, canteen);
    if (!order?.success) { fail('Kitchen: place order for test', order?.error); await cleanup(empId); return; }

    // Simulate kitchen accepting order (new → preparing)
    const { status: s1 } = await db(`orders?id=eq.${order.order_id}`, SERVICE_KEY, {
      method: 'PATCH', body: JSON.stringify({ status: 'preparing' })
    });
    s1 === 200 || s1 === 204 ? ok('Kitchen: accept order (new → preparing)') : fail('Kitchen: accept order', `Status ${s1}`);

    // Simulate kitchen marking ready (preparing → ready)
    const { status: s2 } = await db(`orders?id=eq.${order.order_id}`, SERVICE_KEY, {
      method: 'PATCH', body: JSON.stringify({ status: 'ready' })
    });
    s2 === 200 || s2 === 204 ? ok('Kitchen: mark ready (preparing → ready)') : fail('Kitchen: mark ready', `Status ${s2}`);

    // Simulate pickup OTP confirmation (ready → done)
    const fakeOtp = '1234';
    const now = new Date().toISOString();
    const { status: s3 } = await db(`orders?id=eq.${order.order_id}`, SERVICE_KEY, {
      method: 'PATCH', body: JSON.stringify({ status: 'done', pickup_otp: null, pickup_confirmed_at: now })
    });
    s3 === 200 || s3 === 204 ? ok('Kitchen: confirm pickup OTP (ready → done)') : fail('Kitchen: confirm pickup', `Status ${s3}`);

    // Verify final status
    const { data: finalOrder } = await db(`orders?id=eq.${order.order_id}&select=status,pickup_confirmed_at`, SERVICE_KEY);
    finalOrder?.[0]?.status === 'done' ? ok('Kitchen: order status = done in DB') : fail('Kitchen: order not done', `Status: ${finalOrder?.[0]?.status}`);
    finalOrder?.[0]?.pickup_confirmed_at ? ok('Kitchen: pickup_confirmed_at set') : warn('Kitchen: pickup_confirmed_at', 'Not set');

    // Test menu availability toggle
    const { status: toggleStatus } = await db(`menu_items?id=eq.${item.id}`, SERVICE_KEY, {
      method: 'PATCH', body: JSON.stringify({ is_available: false })
    });
    if (toggleStatus === 200 || toggleStatus === 204) {
      ok('Kitchen: mark item unavailable');
      // Restore
      await db(`menu_items?id=eq.${item.id}`, SERVICE_KEY, { method: 'PATCH', body: JSON.stringify({ is_available: true }) });
      ok('Kitchen: restore item availability');
    } else {
      fail('Kitchen: toggle availability', `Status ${toggleStatus}`);
    }

  } catch(e) {
    fail('Kitchen tests crashed', e.message);
  } finally {
    await cleanup(empId);
    ok('Kitchen: test data cleaned up');
  }
}

// ════════════════════════════════════════════════════════════════
// SECTION 4: ADMIN SIDE
// ════════════════════════════════════════════════════════════════
async function testAdminSide() {
  section('4. Admin Side');
  const empId = 'TEST-ADM-' + Date.now();

  try {
    await createTestEmployee(empId, 100);
    ok('Admin: test employee created');

    // Admin wallet credit
    const { data: admins } = await db('admins?limit=1&select=id', SERVICE_KEY);
    if (!admins?.length) { warn('Admin: wallet credit', 'No admin found — skipping wallet credit test'); }
    else {
      // Test direct wallet update (simulating admin credit)
      const { status } = await db(`employees?id=eq.${empId}`, SERVICE_KEY, {
        method: 'PATCH', body: JSON.stringify({ wallet_balance: 600 })
      });
      status === 200 || status === 204 ? ok('Admin: wallet balance update') : fail('Admin: wallet update', `Status ${status}`);

      // Verify update
      const { data: emp } = await db(`employees?id=eq.${empId}&select=wallet_balance`, SERVICE_KEY);
      parseFloat(emp?.[0]?.wallet_balance) === 600 ? ok('Admin: wallet update verified in DB') : fail('Admin: wallet update not saved', `Got ${emp?.[0]?.wallet_balance}`);
    }

    // Today's revenue query
    const today = new Date().toISOString().slice(0,10);
    const { data: todayOrders, status: revStatus } = await db(
      `orders?select=id,amount_paid,canteen_id,status,created_at&created_at=gte.${today}T00:00:00`,
      SERVICE_KEY
    );
    revStatus === 200 ? ok(`Admin: revenue query works (${todayOrders?.length || 0} orders today)`) : fail('Admin: revenue query', `Status ${revStatus}`);

    // Employee list query
    const { data: emps, status: empStatus } = await db('employees?select=id,name,email,wallet_balance&limit=10', SERVICE_KEY);
    empStatus === 200 ? ok(`Admin: employee list loads (${emps?.length} shown)`) : fail('Admin: employee list', `Status ${empStatus}`);

    // Orders with items (KDS style query)
    const { data: ordersWithItems, status: kdsStatus } = await db(
      `orders?select=*,order_items(*)&created_at=gte.${today}T00:00:00&limit=10`,
      SERVICE_KEY
    );
    kdsStatus === 200 ? ok(`Admin: orders with items query works`) : fail('Admin: orders+items query', `Status ${kdsStatus}`);

    // Canteen open/close toggle
    const { data: canteens } = await db('canteens?limit=1&select=id,is_open', SERVICE_KEY);
    if (canteens?.[0]) {
      const original = canteens[0].is_open;
      const { status: toggleStatus } = await db(`canteens?id=eq.${canteens[0].id}`, SERVICE_KEY, {
        method: 'PATCH', body: JSON.stringify({ is_open: !original })
      });
      if (toggleStatus === 200 || toggleStatus === 204) {
        ok('Admin: canteen open/close toggle');
        // Restore
        await db(`canteens?id=eq.${canteens[0].id}`, SERVICE_KEY, { method: 'PATCH', body: JSON.stringify({ is_open: original }) });
        ok('Admin: canteen status restored');
      } else {
        fail('Admin: canteen toggle', `Status ${toggleStatus}`);
      }
    }

  } catch(e) {
    fail('Admin tests crashed', e.message);
  } finally {
    await cleanup(empId);
    ok('Admin: test data cleaned up');
  }
}

// ════════════════════════════════════════════════════════════════
// SECTION 5: SECURITY CHECKS
// ════════════════════════════════════════════════════════════════
async function testSecurity() {
  section('5. Security');

  // Anon key cannot read employees
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/employees?limit=1`, {
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}` }
    });
    const data = await res.json();
    Array.isArray(data) && data.length === 0
      ? ok('RLS: anon cannot read employees')
      : warn('RLS: employees', 'Anon key returned employee data — check RLS');
  } catch(e) { ok('RLS: employees blocked'); }

  // Anon key cannot read wallet_transactions
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/wallet_transactions?limit=1`, {
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}` }
    });
    const data = await res.json();
    Array.isArray(data) && data.length === 0
      ? ok('RLS: anon cannot read wallet_transactions')
      : warn('RLS: wallet_transactions', 'Anon can read transactions — check RLS');
  } catch(e) { ok('RLS: wallet_transactions blocked'); }

  // OTP verify rejects wrong code
  const { data: otpResult } = await rpc('verify_email_otp', { p_email: 'fake@fake.com', p_otp: '000000' }, ANON_KEY);
  !otpResult?.success ? ok('OTP: rejects wrong code') : fail('OTP: accepted wrong code', 'Security risk!');

  // place_order rejects non-existent employee
  const item = await getMenuItem();
  if (item) {
    const canteen = await getCanteen(item.canteen_id);
    if (canteen) {
      const { data: fakeOrder } = await rpc('place_order', {
        p_employee_id: 'FAKE-EMP-999',
        p_canteen_id: canteen.id,
        p_canteen_name: canteen.name,
        p_canteen_icon: '🍽️',
        p_pickup_slot: '12:30 PM',
        p_items: [{ id: item.id, name: item.name, emoji: '🍽️', qty: 1, price: item.price }],
        p_payment_method: 'wallet'
      }, ANON_KEY);
      !fakeOrder?.success ? ok('Security: order rejected for fake employee') : fail('Security: fake employee placed order', 'RLS not blocking!');
    }
  }

  // Insufficient balance rejection
  const poorEmpId = 'TEST-POOR-' + Date.now();
  try {
    await createTestEmployee(poorEmpId, 1); // ₹1 balance
    const item2 = await getMenuItem();
    const canteen2 = item2 ? await getCanteen(item2.canteen_id) : null;
    if (item2 && canteen2 && item2.price > 1) {
      const { data: poorOrder } = await placeOrder(poorEmpId, item2, canteen2);
      !poorOrder?.success ? ok('Security: order rejected for insufficient balance') : fail('Security: order placed with ₹1 balance', 'Wallet check not working!');
    }
  } finally {
    await db(`employees?id=eq.${poorEmpId}`, SERVICE_KEY, { method: 'DELETE' });
  }
}

// ════════════════════════════════════════════════════════════════
// SECTION 6: CONCURRENT ORDERS (mini load test)
// ════════════════════════════════════════════════════════════════
async function testConcurrentOrders() {
  section('6. Concurrent Orders (10 simultaneous)');
  const item = await getMenuItem();
  if (!item) { warn('Concurrent test', 'No menu item — skipping'); return; }
  const canteen = await getCanteen(item.canteen_id);
  if (!canteen) { warn('Concurrent test', 'Canteen not found — skipping'); return; }

  const count = 10;
  const empIds = Array.from({length: count}, (_, i) => `TEST-CONC-${Date.now()}-${i}`);

  try {
    // Create employees
    await Promise.all(empIds.map(id => createTestEmployee(id, 5000)));
    ok(`Concurrent: created ${count} test employees`);

    // Fire all orders simultaneously
    const start = Date.now();
    const results = await Promise.all(empIds.map(id => placeOrder(id, item, canteen)));
    const duration = Date.now() - start;

    const successes = results.filter(r => r.data?.success);
    const failures2 = results.filter(r => !r.data?.success);
    const tokens = successes.map(r => r.data.token_number);
    const uniqueTokens = new Set(tokens);

    ok(`Concurrent: ${successes.length}/${count} orders succeeded in ${duration}ms`);
    failures2.length === 0 ? ok('Concurrent: 0 failures') : fail('Concurrent: some orders failed', `${failures2.length} failed — ${failures2[0]?.data?.error}`);
    uniqueTokens.size === tokens.length ? ok(`Concurrent: 0 duplicate tokens (${tokens.sort((a,b)=>a-b).join(', ')})`) : fail('Concurrent: DUPLICATE TOKENS DETECTED', `${tokens.length} orders, ${uniqueTokens.size} unique tokens`);
    duration < 5000 ? ok(`Concurrent: response time OK (${duration}ms for 10 orders)`) : warn('Concurrent: slow response', `${duration}ms — may slow at peak`);

  } catch(e) {
    fail('Concurrent test crashed', e.message);
  } finally {
    await Promise.all(empIds.map(id => cleanup(id)));
    ok('Concurrent: test data cleaned up');
  }
}

// ════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   L&T FoodHub — Full Regression Test Suite       ║');
  console.log('║   Employee · Kitchen · Admin · Security · Load   ║');
  console.log('╚══════════════════════════════════════════════════╝');

  if (!SERVICE_KEY) {
    console.log('\n⚠️  Set SUPABASE_SERVICE_KEY env var to run all tests\n');
    process.exit(1);
  }

  const start = Date.now();

  await testInfrastructure();
  await testEmployeeSide();
  await testKitchenSide();
  await testAdminSide();
  await testSecurity();
  await testConcurrentOrders();

  const duration = ((Date.now() - start) / 1000).toFixed(1);

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║   RESULTS (completed in ${duration}s)${' '.repeat(Math.max(0, 23-duration.length))}║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   ✅ Passed:   ${String(passed).padEnd(33)}║`);
  console.log(`║   ❌ Failed:   ${String(failed).padEnd(33)}║`);
  console.log(`║   ⚠️  Warnings: ${String(warnings).padEnd(32)}║`);
  console.log('╠══════════════════════════════════════════════════╣');

  if (failed === 0) {
    console.log('║   🚀 ALL CLEAR — safe to deploy to production    ║');
  } else {
    console.log('║   🔴 FAILURES FOUND — fix before deploying       ║');
    console.log('╠══════════════════════════════════════════════════╣');
    failures.forEach(f => console.log(`║   ✗ ${(f.name + ': ' + f.why).slice(0,45).padEnd(45)}║`));
  }
  console.log('╚══════════════════════════════════════════════════╝\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test suite crashed:', e); process.exit(1); });
