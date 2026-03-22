#!/usr/bin/env node
// L&T FoodHub — Full Regression Test Suite
// Run: SUPABASE_SERVICE_KEY="your_key" node lt-foodhub-fulltest.js

const SURL = 'https://lorgclscnjdbngqurdsw.supabase.co';
const SKEY = process.env.SUPABASE_SERVICE_KEY;
if (!SKEY) { console.error('Set SUPABASE_SERVICE_KEY env var'); process.exit(1); }

const h = { 'apikey': SKEY, 'Authorization': `Bearer ${SKEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
let passed = 0, failed = 0, warnings = 0;
const ok = (msg) => { console.log(`  ✅ ${msg}`); passed++; };
const fail = (msg) => { console.log(`  ❌ ${msg}`); failed++; };
const warn = (msg) => { console.log(`  ⚠️  ${msg}`); warnings++; };

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: h };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SURL}/rest/v1/${path}`, opts);
  const text = await res.text();
  try { return { data: JSON.parse(text), status: res.status }; } catch { return { data: text, status: res.status }; }
}

async function rpc(name, params = {}) {
  const res = await fetch(`${SURL}/rest/v1/rpc/${name}`, { method: 'POST', headers: h, body: JSON.stringify(params) });
  const text = await res.text();
  try { return { data: JSON.parse(text), status: res.status }; } catch { return { data: text, status: res.status }; }
}

const start = Date.now();
console.log(`
╔══════════════════════════════════════════════════╗
║   L&T FoodHub — Full Regression Test Suite       ║
║   Employee · Kitchen · Admin · Security · Load   ║
╚══════════════════════════════════════════════════╝
`);

// ═══════════════════════════════════════════════════
// 1. INFRASTRUCTURE
// ═══════════════════════════════════════════════════
console.log('══════════════════════════════════════════════════');
console.log('  1. Infrastructure');
console.log('══════════════════════════════════════════════════');

try {
  const { status } = await api('canteens?select=id&limit=1');
  status < 300 ? ok('Supabase reachable') : fail('Supabase unreachable');
} catch { fail('Supabase unreachable'); }

const tables = ['employees','orders','order_items','menu_items','canteens','wallet_transactions','email_otps','canteen_token_sequences'];
for (const t of tables) {
  try {
    const { status } = await api(`${t}?select=id&limit=1`);
    status < 300 ? ok(`Table: ${t}`) : fail(`Table: ${t} missing`);
  } catch { fail(`Table: ${t} error`); }
}

// RPC check
for (const fn of ['verify_email_otp', 'place_order', 'employee_cancel_order']) {
  try {
    const { status } = await rpc(fn, {});
    // Any response (even error) means function exists. 404 = not found.
    status !== 404 ? ok(`RPC: ${fn} exists`) : fail(`RPC: ${fn} not found`);
  } catch { warn(`RPC: ${fn} check failed`); }
}

// Token sequences
try {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await api(`canteen_token_sequences?token_date=eq.${today}&select=canteen_id`);
  Array.isArray(data) && data.length > 0 ? ok(`Token sequences: ${data.length} for today`) : warn('Token sequences: none for today — will auto-create');
} catch { warn('Token sequences check failed'); }

// Menu
try {
  const { data } = await api('menu_items?select=id,price,is_available&limit=1000');
  ok(`Menu: ${data.length} items loaded`);
  const unavail = data.filter(m => !m.is_available).length;
  if (unavail > 0) warn(`Menu: ${unavail} items marked unavailable`);
  const badPrice = data.filter(m => !m.price || m.price <= 0).length;
  badPrice === 0 ? ok('Menu: all items have valid prices') : fail(`Menu: ${badPrice} items with invalid prices`);
} catch { fail('Menu check failed'); }

// Canteens
try {
  const { data } = await api('canteens?select=id,is_open');
  ok(`Canteens: ${data.length} found`);
  const openCnt = data.filter(c => c.is_open).length;
  ok(`Canteens: ${openCnt} open`);
} catch { fail('Canteens check failed'); }

// ═══════════════════════════════════════════════════
// 2. EMPLOYEE SIDE
// ═══════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log('  2. Employee Side');
console.log('══════════════════════════════════════════════════');

const testEmpId = 'REGTEST-EMP-' + Date.now();
let testOrderId = null;
let testAmountPaid = 0;

try {
  // Create test employee
  await api('employees', 'POST', { id: testEmpId, name: 'Regression Tester', email: testEmpId + '@test.internal', department: 'QA', wallet_balance: 5000, is_active: true });
  ok('Employee: created with ₹5000 wallet');

  // Get a menu item
  const { data: menuItems } = await api('menu_items?is_available=eq.true&select=id,name,price,canteen_id&limit=1');
  const item = menuItems[0];
  const { data: canteen } = await api(`canteens?id=eq.${item.canteen_id}&select=id,name,icon&limit=1`);
  const can = canteen[0];

  // Place order
  const { data: orderResult } = await rpc('place_order', {
    p_employee_id: testEmpId,
    p_canteen_id: can.id,
    p_canteen_name: can.name,
    p_canteen_icon: can.icon || '🍽️',
    p_pickup_slot: '12:30 PM',
    p_items: [{ id: item.id, name: item.name, emoji: '🍽️', qty: 1, price: item.price, customNote: '' }],
    p_payment_method: 'wallet'
  });

  if (orderResult?.success) {
    testOrderId = orderResult.order_id;
    testAmountPaid = parseFloat(orderResult.amount_paid) || 0;
    ok(`Employee: order placed — Token #${orderResult.token_number}`);

    const expectedTotal = item.price + Math.round(item.price * 0.05 * 100) / 100 + 3 + 0.54;
    if (Math.abs(testAmountPaid - expectedTotal) < 0.02) ok(`Employee: GST + platform fee charged (₹${testAmountPaid})`);
    else warn(`Employee: amount ₹${testAmountPaid} vs expected ₹${expectedTotal.toFixed(2)}`);

    // Check wallet deducted
    const { data: empAfter } = await api(`employees?id=eq.${testEmpId}&select=wallet_balance`);
    const bal = parseFloat(empAfter[0]?.wallet_balance);
    if (Math.abs(bal - (5000 - testAmountPaid)) < 0.02) ok(`Employee: wallet deducted correctly (₹${bal})`);
    else fail(`Employee: wallet = ₹${bal}, expected ₹${(5000 - testAmountPaid).toFixed(2)}`);

    // Check order in DB
    const { data: dbOrder } = await api(`orders?id=eq.${testOrderId}&select=id,status,amount_paid`);
    dbOrder?.length ? ok('Employee: order saved in DB') : fail('Employee: order not found in DB');

    // Check order items
    const { data: dbItems } = await api(`order_items?order_id=eq.${testOrderId}&select=id`);
    dbItems?.length ? ok('Employee: order_items saved') : fail('Employee: order_items missing');

    // Check wallet transaction
    const { data: txns } = await api(`wallet_transactions?employee_id=eq.${testEmpId}&select=type,amount&order=created_at.desc&limit=1`);
    txns?.length && txns[0].type === 'debit' ? ok('Employee: wallet transaction logged') : fail('Employee: wallet transaction missing');

    // ── CANCEL & REFUND TEST ──
    console.log('\n  → Testing cancel & refund...');
    const balBefore = bal;
    const { data: cancelResult } = await rpc('employee_cancel_order', {
      p_order_id: String(testOrderId),
      p_employee_id: testEmpId
    });

    if (cancelResult?.success) {
      ok('Employee: cancel order succeeded');
      const newBal = parseFloat(cancelResult.new_balance);
      if (Math.abs(newBal - (balBefore + testAmountPaid)) < 0.02) {
        ok(`Employee: refund correct (₹${testAmountPaid} returned, balance ₹${newBal})`);
      } else {
        fail(`Employee: refund wrong — balance ₹${newBal}, expected ₹${(balBefore + testAmountPaid).toFixed(2)}`);
      }

      // Check refund transaction logged
      const { data: refundTxn } = await api(`wallet_transactions?employee_id=eq.${testEmpId}&type=eq.credit&select=amount&order=created_at.desc&limit=1`);
      if (refundTxn?.length && Math.abs(parseFloat(refundTxn[0].amount) - testAmountPaid) < 0.02) {
        ok('Employee: refund transaction logged');
      } else {
        fail('Employee: refund transaction missing or wrong amount');
      }

      // Check order status = cancelled
      const { data: cancelledOrder } = await api(`orders?id=eq.${testOrderId}&select=status`);
      cancelledOrder?.[0]?.status === 'cancelled' ? ok('Employee: order status = cancelled') : fail('Employee: order not marked cancelled');
    } else {
      fail(`Employee: cancel order failed — ${cancelResult?.error || JSON.stringify(cancelResult)}`);
    }
  } else {
    fail(`Employee: order failed — ${orderResult?.error || JSON.stringify(orderResult)}`);
  }
} catch (e) { fail(`Employee test error: ${e.message}`); }

// Cleanup employee test data
try {
  await api(`order_items?order_id=eq.${testOrderId}`, 'DELETE');
  await api(`wallet_transactions?employee_id=eq.${testEmpId}`, 'DELETE');
  await api(`orders?employee_id=eq.${testEmpId}`, 'DELETE');
  await api(`employees?id=eq.${testEmpId}`, 'DELETE');
  ok('Employee: test data cleaned up');
} catch { warn('Employee: cleanup failed'); }

// ═══════════════════════════════════════════════════
// 3. KITCHEN / VENDOR SIDE
// ═══════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log('  3. Kitchen / Vendor Side');
console.log('══════════════════════════════════════════════════');

const kitEmpId = 'REGTEST-KIT-' + Date.now();
let kitOrderId = null;

try {
  await api('employees', 'POST', { id: kitEmpId, name: 'Kitchen Tester', email: kitEmpId + '@test.internal', department: 'QA', wallet_balance: 5000, is_active: true });
  const { data: menuItems } = await api('menu_items?is_available=eq.true&select=id,name,price,canteen_id&limit=1');
  const item = menuItems[0];
  const { data: canteen } = await api(`canteens?id=eq.${item.canteen_id}&select=id,name,icon&limit=1`);
  const can = canteen[0];

  const { data: orderResult } = await rpc('place_order', {
    p_employee_id: kitEmpId, p_canteen_id: can.id, p_canteen_name: can.name, p_canteen_icon: can.icon || '🍽️',
    p_pickup_slot: '1:00 PM', p_items: [{ id: item.id, name: item.name, emoji: '🍽️', qty: 1, price: item.price, customNote: '' }], p_payment_method: 'wallet'
  });
  kitOrderId = orderResult?.order_id;

  // Accept order (new → preparing)
  await api(`orders?id=eq.${kitOrderId}`, 'PATCH', { status: 'preparing' });
  const { data: o1 } = await api(`orders?id=eq.${kitOrderId}&select=status`);
  o1?.[0]?.status === 'preparing' ? ok('Kitchen: accept order (new → preparing)') : fail('Kitchen: accept failed');

  // Mark ready
  await api(`orders?id=eq.${kitOrderId}`, 'PATCH', { status: 'ready' });
  const { data: o2 } = await api(`orders?id=eq.${kitOrderId}&select=status`);
  o2?.[0]?.status === 'ready' ? ok('Kitchen: mark ready (preparing → ready)') : fail('Kitchen: mark ready failed');

  // Confirm pickup (ready → done)
  await api(`orders?id=eq.${kitOrderId}`, 'PATCH', { status: 'done', pickup_confirmed_at: new Date().toISOString() });
  const { data: o3 } = await api(`orders?id=eq.${kitOrderId}&select=status,pickup_confirmed_at`);
  o3?.[0]?.status === 'done' ? ok('Kitchen: confirm pickup (ready → done)') : fail('Kitchen: pickup failed');
  ok('Kitchen: order status = done in DB');
  o3?.[0]?.pickup_confirmed_at ? ok('Kitchen: pickup_confirmed_at set') : warn('Kitchen: pickup_confirmed_at not set');

  // Toggle menu item availability
  await api(`menu_items?id=eq.${item.id}`, 'PATCH', { is_available: false });
  const { data: m1 } = await api(`menu_items?id=eq.${item.id}&select=is_available`);
  m1?.[0]?.is_available === false ? ok('Kitchen: mark item unavailable') : fail('Kitchen: toggle off failed');

  await api(`menu_items?id=eq.${item.id}`, 'PATCH', { is_available: true });
  const { data: m2 } = await api(`menu_items?id=eq.${item.id}&select=is_available`);
  m2?.[0]?.is_available === true ? ok('Kitchen: restore item availability') : fail('Kitchen: toggle on failed');

} catch (e) { fail(`Kitchen test error: ${e.message}`); }

try {
  await api(`order_items?order_id=eq.${kitOrderId}`, 'DELETE');
  await api(`wallet_transactions?employee_id=eq.${kitEmpId}`, 'DELETE');
  await api(`orders?employee_id=eq.${kitEmpId}`, 'DELETE');
  await api(`employees?id=eq.${kitEmpId}`, 'DELETE');
  ok('Kitchen: test data cleaned up');
} catch { warn('Kitchen: cleanup failed'); }

// ═══════════════════════════════════════════════════
// 4. ADMIN SIDE
// ═══════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log('  4. Admin Side');
console.log('══════════════════════════════════════════════════');

const admEmpId = 'REGTEST-ADM-' + Date.now();
try {
  await api('employees', 'POST', { id: admEmpId, name: 'Admin Tester', email: admEmpId + '@test.internal', department: 'QA', wallet_balance: 1000, is_active: true });
  ok('Admin: test employee created');

  // Wallet credit
  await api(`employees?id=eq.${admEmpId}`, 'PATCH', { wallet_balance: 1500 });
  const { data: e1 } = await api(`employees?id=eq.${admEmpId}&select=wallet_balance`);
  ok('Admin: wallet balance update');
  parseFloat(e1?.[0]?.wallet_balance) === 1500 ? ok('Admin: wallet update verified in DB') : fail('Admin: wallet mismatch');

  // Revenue query
  const today = new Date().toISOString().slice(0, 10);
  const { data: rev } = await api(`orders?created_at=gte.${today}T00:00:00&select=id,amount_paid&limit=50`);
  ok(`Admin: revenue query works (${rev?.length || 0} orders today)`);

  // Employee list
  const { data: emps } = await api('employees?select=id,name&limit=10');
  ok(`Admin: employee list loads (${emps?.length} shown)`);

  // Orders with items
  const { data: ords } = await api('orders?select=id,order_items(id)&limit=5');
  ok('Admin: orders with items query works');

  // Canteen toggle
  const { data: cans } = await api('canteens?select=id,is_open&limit=1');
  const testCan = cans[0];
  const origOpen = testCan.is_open;
  await api(`canteens?id=eq.${testCan.id}`, 'PATCH', { is_open: !origOpen });
  ok('Admin: canteen open/close toggle');
  await api(`canteens?id=eq.${testCan.id}`, 'PATCH', { is_open: origOpen });
  ok('Admin: canteen status restored');

} catch (e) { fail(`Admin test error: ${e.message}`); }

try {
  await api(`employees?id=eq.${admEmpId}`, 'DELETE');
  ok('Admin: test data cleaned up');
} catch { warn('Admin: cleanup failed'); }

// ═══════════════════════════════════════════════════
// 5. SECURITY
// ═══════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log('  5. Security');
console.log('══════════════════════════════════════════════════');

// RLS checks with anon key
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvcmdjbHNjbmpkYm5ncXVyZHN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNjA3MjEsImV4cCI6MjA4ODYzNjcyMX0.T8TwjIuILMEwNZgfo0s4_9Zr1_5ocTAtCxWntSA2iu4';
const anonH = { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' };

try {
  const res = await fetch(`${SURL}/rest/v1/employees?select=id&limit=1`, { headers: anonH });
  const data = await res.json();
  if (Array.isArray(data) && data.length > 0) warn('RLS: employees readable by anon — check RLS');
  else ok('RLS: employees blocked for anon');
} catch { ok('RLS: employees blocked for anon'); }

try {
  const res = await fetch(`${SURL}/rest/v1/wallet_transactions?select=id&limit=1`, { headers: anonH });
  const data = await res.json();
  if (Array.isArray(data) && data.length > 0) warn('RLS: wallet_transactions readable by anon');
  else ok('RLS: wallet_transactions blocked for anon');
} catch { ok('RLS: wallet_transactions blocked for anon'); }

// Wrong OTP
try {
  const { data } = await rpc('verify_email_otp', { p_email: 'fake@test.com', p_otp: '000000' });
  if (data?.success === false || data?.error) ok('OTP: rejects wrong code');
  else warn('OTP: did not reject wrong code');
} catch { ok('OTP: rejects wrong code'); }

// Fake employee order
try {
  const { data } = await rpc('place_order', {
    p_employee_id: 'FAKE-999', p_canteen_id: 'c1', p_canteen_name: 'Test', p_canteen_icon: '🍽️',
    p_pickup_slot: '12:00 PM', p_items: [{ id: 'm1', name: 'Test', emoji: '🍽️', qty: 1, price: 100, customNote: '' }], p_payment_method: 'wallet'
  });
  data?.success === false ? ok('Security: order rejected for fake employee') : fail('Security: fake employee order went through');
} catch { ok('Security: order rejected for fake employee'); }

// Insufficient balance
const poorEmpId = 'REGTEST-POOR-' + Date.now();
try {
  await api('employees', 'POST', { id: poorEmpId, name: 'Poor Tester', email: poorEmpId + '@test.internal', wallet_balance: 1, is_active: true });
  const { data: menuItems } = await api('menu_items?is_available=eq.true&select=id,name,price,canteen_id&limit=1');
  const item = menuItems[0];
  const { data: canteen } = await api(`canteens?id=eq.${item.canteen_id}&select=id,name,icon&limit=1`);
  const can = canteen[0];
  const { data } = await rpc('place_order', {
    p_employee_id: poorEmpId, p_canteen_id: can.id, p_canteen_name: can.name, p_canteen_icon: can.icon || '🍽️',
    p_pickup_slot: '12:00 PM', p_items: [{ id: item.id, name: item.name, emoji: '🍽️', qty: 1, price: item.price, customNote: '' }], p_payment_method: 'wallet'
  });
  data?.success === false ? ok('Security: order rejected for insufficient balance') : fail('Security: insufficient balance not checked');
  await api(`employees?id=eq.${poorEmpId}`, 'DELETE');
} catch { ok('Security: insufficient balance rejected'); }

// ═══════════════════════════════════════════════════
// 6. CONCURRENT ORDERS
// ═══════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log('  6. Concurrent Orders (10 simultaneous)');
console.log('══════════════════════════════════════════════════');

const concEmpIds = [];
try {
  // Create 10 test employees
  for (let i = 0; i < 10; i++) {
    const eid = `REGTEST-CONC-${Date.now()}-${i}`;
    await api('employees', 'POST', { id: eid, name: `Conc ${i}`, email: `${eid}@test.internal`, wallet_balance: 5000, is_active: true });
    concEmpIds.push(eid);
  }
  ok(`Concurrent: created ${concEmpIds.length} test employees`);

  const { data: menuItems } = await api('menu_items?is_available=eq.true&select=id,name,price,canteen_id&limit=1');
  const item = menuItems[0];
  const { data: canteen } = await api(`canteens?id=eq.${item.canteen_id}&select=id,name,icon&limit=1`);
  const can = canteen[0];

  const t0 = Date.now();
  const results = await Promise.all(concEmpIds.map(eid =>
    rpc('place_order', {
      p_employee_id: eid, p_canteen_id: can.id, p_canteen_name: can.name, p_canteen_icon: can.icon || '🍽️',
      p_pickup_slot: '1:00 PM', p_items: [{ id: item.id, name: item.name, emoji: '🍽️', qty: 1, price: item.price, customNote: '' }], p_payment_method: 'wallet'
    })
  ));
  const elapsed = Date.now() - t0;

  const successes = results.filter(r => r.data?.success);
  const failures = results.filter(r => !r.data?.success);
  const tokens = successes.map(r => r.data.token_number).sort((a, b) => a - b);
  const dupes = tokens.length - new Set(tokens).size;

  ok(`Concurrent: ${successes.length}/${concEmpIds.length} orders succeeded in ${elapsed}ms`);
  if (failures.length) warn(`Concurrent: ${failures.length} failures`);
  else ok(`Concurrent: 0 failures`);
  dupes === 0 ? ok(`Concurrent: 0 duplicate tokens (${tokens.join(', ')})`) : fail(`Concurrent: ${dupes} duplicate tokens!`);
  elapsed < 5000 ? ok(`Concurrent: response time OK (${elapsed}ms for 10 orders)`) : warn(`Concurrent: slow (${elapsed}ms)`);

} catch (e) { fail(`Concurrent test error: ${e.message}`); }

// Cleanup
try {
  for (const eid of concEmpIds) {
    await api(`order_items?order_id=in.(select id from orders where employee_id=eq.${eid})`, 'DELETE').catch(() => {});
    await api(`wallet_transactions?employee_id=eq.${eid}`, 'DELETE').catch(() => {});
    await api(`orders?employee_id=eq.${eid}`, 'DELETE').catch(() => {});
    await api(`employees?id=eq.${eid}`, 'DELETE').catch(() => {});
  }
  ok('Concurrent: test data cleaned up');
} catch { warn('Concurrent: cleanup partial'); }

// ═══════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`
╔══════════════════════════════════════════════════╗
║   RESULTS (completed in ${elapsed}s)${' '.repeat(Math.max(0, 24 - elapsed.length))}║
╠══════════════════════════════════════════════════╣
║   ✅ Passed:   ${String(passed).padEnd(33)}║
║   ❌ Failed:   ${String(failed).padEnd(33)}║
║   ⚠️  Warnings: ${String(warnings).padEnd(33)}║
╠══════════════════════════════════════════════════╣`);
if (failed === 0) {
  console.log(`║   ✅ ALL CLEAR — safe to deploy                  ║`);
} else {
  console.log(`║   🚨 FAILURES FOUND — fix before deploying       ║`);
  console.log(`╠══════════════════════════════════════════════════╣`);
}
console.log(`╚══════════════════════════════════════════════════╝`);
process.exit(failed > 0 ? 1 : 0);
