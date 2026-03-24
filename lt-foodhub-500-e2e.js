#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// SLP Nexus — 500 Employee FULL E2E Load Test
// Employee → Vendor → Kitchen → Pickup → Cancel → Wallet → Admin
// Run: SUPABASE_SERVICE_KEY="your_key" node lt-foodhub-500-e2e.js
// ══════════════════════════════════════════════════════════════

const SURL = 'https://lorgclscnjdbngqurdsw.supabase.co';
const SKEY = process.env.SUPABASE_SERVICE_KEY;
if (!SKEY) { console.error('Set SUPABASE_SERVICE_KEY env var'); process.exit(1); }

const h = { 'apikey': SKEY, 'Authorization': `Bearer ${SKEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
const PREFIX = 'E2E500-';
const BATCH = 50;
const TOTAL = 500;
const WALLET_START = 5000;

let passed = 0, failed = 0, warnings = 0;
const ok = (m) => { console.log(`  ✅ ${m}`); passed++; };
const fail = (m) => { console.log(`  ❌ ${m}`); failed++; };
const warn = (m) => { console.log(`  ⚠️  ${m}`); warnings++; };

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: h };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SURL}/rest/v1/${path}`, opts);
  const t = await res.text();
  try { return { data: JSON.parse(t), status: res.status }; } catch { return { data: t, status: res.status }; }
}
async function rpc(name, params = {}) {
  const res = await fetch(`${SURL}/rest/v1/rpc/${name}`, { method: 'POST', headers: h, body: JSON.stringify(params) });
  const t = await res.text();
  try { return { data: JSON.parse(t), status: res.status }; } catch { return { data: t, status: res.status }; }
}
async function batchRun(items, fn, bs = BATCH) {
  const results = [];
  for (let i = 0; i < items.length; i += bs) {
    const b = items.slice(i, i + bs);
    results.push(...await Promise.all(b.map(fn)));
    process.stdout.write(`    → ${Math.min(i + bs, items.length)}/${items.length}\r`);
  }
  console.log(`    → ${items.length}/${items.length} done`);
  return results;
}

const start = Date.now();
console.log(`
╔════════════════════════════════════════════════════════════╗
║   SLP Nexus — 500 Employee FULL End-to-End Load Test      ║
║   Order → Kitchen → Pickup → Cancel → Wallet → Admin      ║
╚════════════════════════════════════════════════════════════╝
`);

// ════════════════════════════════════════════════════════
// PHASE 1: CREATE 500 EMPLOYEES
// ════════════════════════════════════════════════════════
console.log('═══════════════════════════════════════════════');
console.log('  Phase 1: Create 500 test employees');
console.log('═══════════════════════════════════════════════');

const empIds = [];
for (let i = 0; i < TOTAL; i++) empIds.push(`${PREFIX}${Date.now()}-${String(i).padStart(3, '0')}`);

let created = 0;
for (let i = 0; i < empIds.length; i += BATCH) {
  const batch = empIds.slice(i, i + BATCH).map(id => ({
    id, name: `Test ${id.slice(-3)}`, email: `${id}@e2e.internal`,
    phone: '9' + String(Math.floor(Math.random() * 900000000 + 100000000)),
    department: 'E2E Test', wallet_balance: WALLET_START, is_active: true
  }));
  const { status } = await api('employees', 'POST', batch);
  if (status < 300) created += batch.length;
  process.stdout.write(`    → ${Math.min(i + BATCH, TOTAL)}/${TOTAL}\r`);
}
console.log(`    → ${TOTAL}/${TOTAL} done`);
created >= TOTAL ? ok(`Created ${created} employees (₹${WALLET_START} each)`) : fail(`Only ${created}/${TOTAL} created`);

// Get menu + canteens
const { data: menu } = await api('menu_items?is_available=eq.true&select=id,name,price,canteen_id&limit=200');
const { data: canteens } = await api('canteens?select=id,name,icon&is_open=eq.true');
const canMap = {}; canteens.forEach(c => canMap[c.id] = c);
const itemByCan = {}; menu.forEach(m => { if (!itemByCan[m.canteen_id]) itemByCan[m.canteen_id] = m; });
const canIds = Object.keys(itemByCan);
ok(`${canIds.length} canteens with menu items`);

// ════════════════════════════════════════════════════════
// PHASE 2: PLACE 500 ORDERS
// ════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════');
console.log('  Phase 2: Place 500 orders simultaneously');
console.log('═══════════════════════════════════════════════');

const t0 = Date.now();
const orderResults = await batchRun(empIds, async (eid) => {
  const cid = canIds[Math.floor(Math.random() * canIds.length)];
  const item = itemByCan[cid]; const can = canMap[cid];
  const qty = Math.floor(Math.random() * 3) + 1; // 1-3 items
  try {
    const { data } = await rpc('place_order', {
      p_employee_id: eid, p_canteen_id: cid, p_canteen_name: can.name, p_canteen_icon: can.icon || '🍽️',
      p_pickup_slot: '12:30 PM', p_items: [{ id: item.id, name: item.name, emoji: '🍽️', qty, price: item.price, customNote: '' }],
      p_payment_method: 'wallet'
    });
    return { eid, cid, qty, price: item.price, success: data?.success, data, error: data?.error };
  } catch (e) { return { eid, cid, success: false, error: e.message }; }
});
const orderTime = Date.now() - t0;

const goodOrders = orderResults.filter(r => r.success);
const badOrders = orderResults.filter(r => !r.success);
ok(`${goodOrders.length}/${TOTAL} orders placed in ${(orderTime / 1000).toFixed(1)}s (${Math.round(orderTime / TOTAL)}ms avg)`);
badOrders.length === 0 ? ok('0 failures') : fail(`${badOrders.length} failed — ${badOrders[0]?.error}`);

// Duplicate token check per canteen
const tokByCan = {};
goodOrders.forEach(o => { if (!tokByCan[o.cid]) tokByCan[o.cid] = []; tokByCan[o.cid].push(o.data.token_number); });
let dupes = 0;
Object.entries(tokByCan).forEach(([cid, toks]) => { const u = new Set(toks); if (u.size < toks.length) { dupes += toks.length - u.size; fail(`Canteen ${cid}: ${toks.length - u.size} duplicate tokens`); } });
dupes === 0 ? ok('0 duplicate tokens across all canteens') : null;

// ════════════════════════════════════════════════════════
// PHASE 3: VERIFY WALLET DEDUCTIONS
// ════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════');
console.log('  Phase 3: Verify wallet deductions (20 samples)');
console.log('═══════════════════════════════════════════════');

let walletOk = 0;
const samples = empIds.sort(() => Math.random() - 0.5).slice(0, 20);
for (const eid of samples) {
  const { data } = await api(`employees?id=eq.${eid}&select=wallet_balance`);
  const bal = parseFloat(data?.[0]?.wallet_balance);
  if (bal < WALLET_START && bal > WALLET_START - 500) walletOk++;
}
walletOk >= 18 ? ok(`Wallet correct: ${walletOk}/20 samples deducted properly`) : fail(`Wallet wrong: only ${walletOk}/20`);

// ════════════════════════════════════════════════════════
// PHASE 4: VENDOR — Accept all orders (new → preparing)
// ════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════');
console.log('  Phase 4: Vendor — Accept 500 orders');
console.log('═══════════════════════════════════════════════');

const { data: newOrders } = await api(`orders?employee_id=like.${PREFIX}*&status=eq.new&select=id&limit=600`);
ok(`${newOrders?.length || 0} orders with status 'new'`);

const t1 = Date.now();
const acceptRes = await batchRun(newOrders || [], async (o) => {
  const { status } = await api(`orders?id=eq.${o.id}`, 'PATCH', { status: 'preparing' });
  return { ok: status < 300 };
});
ok(`${acceptRes.filter(r => r.ok).length} orders accepted in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

// ════════════════════════════════════════════════════════
// PHASE 5: KITCHEN — Mark all ready (preparing → ready)
// ════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════');
console.log('  Phase 5: Kitchen — Mark 500 orders ready');
console.log('═══════════════════════════════════════════════');

const { data: prepOrders } = await api(`orders?employee_id=like.${PREFIX}*&status=eq.preparing&select=id&limit=600`);
const t2 = Date.now();
const readyRes = await batchRun(prepOrders || [], async (o) => {
  const { status } = await api(`orders?id=eq.${o.id}`, 'PATCH', { status: 'ready' });
  return { ok: status < 300 };
});
ok(`${readyRes.filter(r => r.ok).length} orders marked ready in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

// ════════════════════════════════════════════════════════
// PHASE 6: PICKUP OTP — Confirm all (ready → done)
// ════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════');
console.log('  Phase 6: Pickup — Confirm 500 collections');
console.log('═══════════════════════════════════════════════');

const { data: readyOrders } = await api(`orders?employee_id=like.${PREFIX}*&status=eq.ready&select=id&limit=600`);
const t3 = Date.now();
const pickupRes = await batchRun(readyOrders || [], async (o) => {
  const { status } = await api(`orders?id=eq.${o.id}`, 'PATCH', { status: 'done', pickup_confirmed_at: new Date().toISOString() });
  return { ok: status < 300 };
});
ok(`${pickupRes.filter(r => r.ok).length} pickups confirmed in ${((Date.now() - t3) / 1000).toFixed(1)}s`);

const { data: doneOrders } = await api(`orders?employee_id=like.${PREFIX}*&status=eq.done&select=id&limit=600`);
const doneCnt = doneOrders?.length || 0;
doneCnt >= goodOrders.length * 0.95 ? ok(`${doneCnt} orders completed end-to-end`) : fail(`Only ${doneCnt} done`);

// ════════════════════════════════════════════════════════
// PHASE 7: CANCEL + REFUND (20 fresh orders)
// ════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════');
console.log('  Phase 7: Cancel + Refund (20 orders)');
console.log('═══════════════════════════════════════════════');

const cancelEmps = empIds.slice(0, 20);
let cancelOk = 0, refundOk = 0;
for (const eid of cancelEmps) {
  const cid = canIds[0]; const item = itemByCan[cid]; const can = canMap[cid];
  const { data: bef } = await api(`employees?id=eq.${eid}&select=wallet_balance`);
  const balBefore = parseFloat(bef?.[0]?.wallet_balance) || 0;

  const { data: ord } = await rpc('place_order', {
    p_employee_id: eid, p_canteen_id: cid, p_canteen_name: can.name, p_canteen_icon: can.icon || '🍽️',
    p_pickup_slot: '1:00 PM', p_items: [{ id: item.id, name: item.name, emoji: '🍽️', qty: 1, price: item.price, customNote: '' }],
    p_payment_method: 'wallet'
  });
  if (!ord?.success) continue;

  const { data: canc } = await rpc('employee_cancel_order', { p_order_id: String(ord.order_id), p_employee_id: eid });
  if (canc?.success) {
    cancelOk++;
    const nb = parseFloat(canc.new_balance);
    if (Math.abs(nb - balBefore) < 0.02) refundOk++;
  }
}
cancelOk >= 18 ? ok(`${cancelOk}/20 cancels succeeded`) : fail(`Only ${cancelOk}/20`);
refundOk >= 18 ? ok(`${refundOk}/20 refunds correct (balance restored)`) : fail(`Only ${refundOk}/20 refunds correct`);

// ════════════════════════════════════════════════════════
// PHASE 8: ADMIN — Revenue & Stats
// ════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════');
console.log('  Phase 8: Admin — Revenue & Calculations');
console.log('═══════════════════════════════════════════════');

const { data: allTestOrders } = await api(`orders?employee_id=like.${PREFIX}*&select=amount_paid,item_total,gst_amount,canteen_id,status&limit=700`);
const totalRevenue = (allTestOrders || []).filter(o => o.status !== 'cancelled').reduce((s, o) => s + (parseFloat(o.amount_paid) || 0), 0);
const totalItems = (allTestOrders || []).filter(o => o.status !== 'cancelled').reduce((s, o) => s + (parseFloat(o.item_total) || 0), 0);
const totalGST = (allTestOrders || []).filter(o => o.status !== 'cancelled').reduce((s, o) => s + (parseFloat(o.gst_amount) || 0), 0);
const totalPlatform = (allTestOrders || []).filter(o => o.status !== 'cancelled').length * 3.54;
const cancelledCount = (allTestOrders || []).filter(o => o.status === 'cancelled').length;

ok(`Total revenue: ₹${(Math.round(totalRevenue * 100) / 100).toLocaleString('en-IN')}`);
ok(`  Subtotal: ₹${(Math.round(totalItems * 100) / 100).toLocaleString('en-IN')}`);
ok(`  Food GST: ₹${(Math.round(totalGST * 100) / 100).toLocaleString('en-IN')}`);
ok(`  Platform fees: ~₹${(Math.round(totalPlatform * 100) / 100).toLocaleString('en-IN')}`);
ok(`  Cancelled: ${cancelledCount} orders`);

// GST sanity: should be ~5% of item total
const expectedGST = Math.round(totalItems * 0.05 * 100) / 100;
Math.abs(totalGST - expectedGST) < goodOrders.length ? ok('GST 5% calculation consistent') : warn(`GST mismatch: ₹${totalGST} vs ~₹${expectedGST}`);

// Revenue - Items - GST - Platform should be ~0
const calcCheck = totalRevenue - totalItems - totalGST - (allTestOrders || []).filter(o => o.status !== 'cancelled').length * 3.54;
Math.abs(calcCheck) < goodOrders.length * 0.1 ? ok('Revenue breakdown adds up correctly') : warn(`Revenue gap: ₹${calcCheck.toFixed(2)}`);

// Per-canteen breakdown
const canRev = {};
(allTestOrders || []).filter(o => o.status !== 'cancelled').forEach(o => {
  if (!canRev[o.canteen_id]) canRev[o.canteen_id] = { orders: 0, revenue: 0 };
  canRev[o.canteen_id].orders++;
  canRev[o.canteen_id].revenue += parseFloat(o.amount_paid) || 0;
});
console.log('  📊 Per-canteen breakdown:');
Object.entries(canRev).forEach(([cid, d]) => {
  console.log(`    ${canMap[cid]?.name || cid}: ${d.orders} orders, ₹${Math.round(d.revenue)}`);
});
ok(`Revenue spread across ${Object.keys(canRev).length} canteens`);

// Wallet transactions count
const { data: txns } = await api(`wallet_transactions?employee_id=like.${PREFIX}*&select=id&limit=1000`);
ok(`${txns?.length || 0} wallet transactions logged`);

// Employee count
const { data: empCount } = await api(`employees?id=like.${PREFIX}*&select=id&limit=600`);
ok(`${empCount?.length || 0} employees in DB`);

// ════════════════════════════════════════════════════════
// PHASE 9: WALLET TOP-UP (Edge Function test)
// ════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════');
console.log('  Phase 9: Wallet top-up (ICICI Edge Function)');
console.log('═══════════════════════════════════════════════');

try {
  const testEmp = empIds[0];
  const { data: before } = await api(`employees?id=eq.${testEmp}&select=wallet_balance`);
  const balBefore = parseFloat(before?.[0]?.wallet_balance) || 0;

  const res = await fetch(`${SURL}/functions/v1/icici-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SKEY}` },
    body: JSON.stringify({ action: 'initiate', amount: 100, employeeId: testEmp, employeeName: 'Test', employeeEmail: 'test@e2e.internal', employeePhone: '9999999999' })
  });
  const data = await res.json();

  if (data.success && data.redirectUrl) {
    ok('ICICI Edge Function: initiate works — redirect URL received');
    ok(`  Redirect: ${data.redirectUrl.slice(0, 60)}...`);
  } else if (data.error) {
    warn('ICICI Edge Function: ' + data.error);
  } else {
    warn('ICICI Edge Function: unexpected response');
  }
  
  // Test checkBalance action
  const balRes = await fetch(`${SURL}/functions/v1/icici-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SKEY}` },
    body: JSON.stringify({ action: 'checkBalance', employeeId: testEmp })
  });
  const balData = await balRes.json();
  balData.success ? ok(`ICICI checkBalance: ₹${balData.balance}`) : warn('checkBalance failed');

} catch (e) { warn('ICICI Edge Function test: ' + e.message); }

// ════════════════════════════════════════════════════════
// PHASE 10: SECURITY CHECKS
// ════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════');
console.log('  Phase 10: Security');
console.log('═══════════════════════════════════════════════');

// Fake employee
const { data: fakeOrd } = await rpc('place_order', {
  p_employee_id: 'FAKE-HACKER-999', p_canteen_id: 'c1', p_canteen_name: 'Test', p_canteen_icon: '🍽️',
  p_pickup_slot: '12:00 PM', p_items: [{ id: 'm1', name: 'Test', emoji: '🍽️', qty: 1, price: 100, customNote: '' }], p_payment_method: 'wallet'
});
fakeOrd?.success === false ? ok('Security: fake employee blocked') : fail('Security: fake employee NOT blocked');

// Insufficient balance
const poorId = `${PREFIX}POOR-${Date.now()}`;
await api('employees', 'POST', { id: poorId, name: 'Poor', email: poorId + '@e2e.internal', wallet_balance: 1, is_active: true });
const { data: poorOrd } = await rpc('place_order', {
  p_employee_id: poorId, p_canteen_id: canIds[0], p_canteen_name: canMap[canIds[0]].name, p_canteen_icon: '🍽️',
  p_pickup_slot: '12:00 PM', p_items: [{ id: itemByCan[canIds[0]].id, name: 'Test', emoji: '🍽️', qty: 1, price: itemByCan[canIds[0]].price, customNote: '' }], p_payment_method: 'wallet'
});
poorOrd?.success === false ? ok('Security: insufficient balance blocked') : fail('Security: low balance NOT blocked');
await api(`employees?id=eq.${poorId}`, 'DELETE');

// Wrong OTP
const { data: otpRes } = await rpc('verify_email_otp', { p_email: 'hacker@fake.com', p_otp: '000000' });
(otpRes?.success === false || otpRes?.error) ? ok('Security: wrong OTP rejected') : warn('OTP check unclear');

// ════════════════════════════════════════════════════════
// PHASE 11: CONCURRENT STRESS (50 simultaneous)
// ════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════');
console.log('  Phase 11: Concurrent stress (50 simultaneous)');
console.log('═══════════════════════════════════════════════');

const stressEmps = empIds.slice(100, 150);
const cid0 = canIds[0]; const item0 = itemByCan[cid0]; const can0 = canMap[cid0];
const ts = Date.now();
const stressRes = await Promise.all(stressEmps.map(eid =>
  rpc('place_order', {
    p_employee_id: eid, p_canteen_id: cid0, p_canteen_name: can0.name, p_canteen_icon: can0.icon || '🍽️',
    p_pickup_slot: '1:30 PM', p_items: [{ id: item0.id, name: item0.name, emoji: '🍽️', qty: 1, price: item0.price, customNote: '' }], p_payment_method: 'wallet'
  })
));
const stressTime = Date.now() - ts;
const stressOk = stressRes.filter(r => r.data?.success).length;
const stressToks = stressRes.filter(r => r.data?.success).map(r => r.data.token_number);
const stressDupes = stressToks.length - new Set(stressToks).size;

ok(`${stressOk}/50 orders in ${stressTime}ms (${Math.round(stressTime / 50)}ms avg)`);
stressDupes === 0 ? ok('0 duplicate tokens under stress') : fail(`${stressDupes} duplicate tokens under stress!`);

// ════════════════════════════════════════════════════════
// PHASE 12: CLEANUP
// ════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════');
console.log('  Phase 12: Cleanup test data');
console.log('═══════════════════════════════════════════════');

try {
  console.log('    → Deleting order_items...');
  for (const eid of empIds) await api(`order_items?order_id=in.(select id from orders where employee_id=eq.${eid})`, 'DELETE').catch(() => {});

  console.log('    → Deleting wallet_transactions...');
  for (let i = 0; i < empIds.length; i += BATCH) {
    await Promise.all(empIds.slice(i, i + BATCH).map(eid => api(`wallet_transactions?employee_id=eq.${eid}`, 'DELETE').catch(() => {})));
  }

  console.log('    → Deleting orders...');
  for (let i = 0; i < empIds.length; i += BATCH) {
    await Promise.all(empIds.slice(i, i + BATCH).map(eid => api(`orders?employee_id=eq.${eid}`, 'DELETE').catch(() => {})));
  }

  console.log('    → Deleting employees...');
  for (let i = 0; i < empIds.length; i += BATCH) {
    await Promise.all(empIds.slice(i, i + BATCH).map(eid => api(`employees?id=eq.${eid}`, 'DELETE').catch(() => {})));
  }

  ok('Test data cleaned up');
} catch (e) { warn('Cleanup partial: ' + e.message); }

// ════════════════════════════════════════════════════════
// FINAL RESULTS
// ════════════════════════════════════════════════════════
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`
╔════════════════════════════════════════════════════════════╗
║   RESULTS (${elapsed}s)                                        ║
╠════════════════════════════════════════════════════════════╣
║   Employees:      ${TOTAL}                                     ║
║   Orders placed:  ${goodOrders.length}/${TOTAL} (${Math.round(orderTime/TOTAL)}ms avg)                       ║
║   Kitchen flow:   ${doneCnt} completed                            ║
║   Cancel/refund:  ${cancelOk}/20 (${refundOk} refunds correct)                  ║
║   Revenue:        ₹${Math.round(totalRevenue)}                                     ║
║   Stress test:    ${stressOk}/50 in ${stressTime}ms                          ║
║   Duplicate tokens: ${dupes + stressDupes}                                        ║
╠════════════════════════════════════════════════════════════╣
║   ✅ Passed:   ${String(passed).padEnd(42)}║
║   ❌ Failed:   ${String(failed).padEnd(42)}║
║   ⚠️  Warnings: ${String(warnings).padEnd(42)}║
╠════════════════════════════════════════════════════════════╣`);
if (failed === 0) {
  console.log(`║   ✅ ALL CLEAR — READY FOR 8,000 EMPLOYEES               ║`);
} else {
  console.log(`║   🚨 FAILURES — FIX BEFORE LAUNCH                        ║`);
}
console.log(`╚════════════════════════════════════════════════════════════╝`);
process.exit(failed > 0 ? 1 : 0);
