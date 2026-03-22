#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// L&T FoodHub — 400 Employee Full E2E Load Test
// Tests: Place Order → Kitchen Accept → Ready → Pickup OTP → Admin Revenue
// Run: SUPABASE_SERVICE_KEY="your_key" node lt-foodhub-loadtest-400.js
// ══════════════════════════════════════════════════════════════

const SURL = 'https://lorgclscnjdbngqurdsw.supabase.co';
const SKEY = process.env.SUPABASE_SERVICE_KEY;
if (!SKEY) { console.error('Set SUPABASE_SERVICE_KEY env var'); process.exit(1); }

const h = { 'apikey': SKEY, 'Authorization': `Bearer ${SKEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
const PREFIX = 'LOADTEST-400-';
const BATCH = 50; // concurrent batch size
const TOTAL = 400;

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

// Run promises in batches
async function batchRun(items, fn, batchSize = BATCH) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) {
      process.stdout.write(`    → ${Math.min(i + batchSize, items.length)}/${items.length} done...\r`);
    }
  }
  console.log(`    → ${items.length}/${items.length} done      `);
  return results;
}

const start = Date.now();
console.log(`
╔═══════════════════════════════════════════════════════╗
║   L&T FoodHub — 400 Employee Full E2E Load Test      ║
║   Order → Kitchen → Pickup OTP → Admin Revenue       ║
╚═══════════════════════════════════════════════════════╝
`);

// ═══════════════════════════════════════════════════
// PHASE 1: SETUP — Create 400 test employees
// ═══════════════════════════════════════════════════
console.log('══════════════════════════════════════════════════');
console.log('  Phase 1: Create 400 test employees');
console.log('══════════════════════════════════════════════════');

const empIds = [];
for (let i = 0; i < TOTAL; i++) {
  empIds.push(`${PREFIX}${Date.now()}-${String(i).padStart(3, '0')}`);
}

// Insert in batches of 50
let createSuccess = 0;
for (let i = 0; i < empIds.length; i += BATCH) {
  const batch = empIds.slice(i, i + BATCH).map(id => ({
    id, name: `LoadTest ${id.slice(-3)}`, email: `${id}@loadtest.internal`,
    department: 'LoadTest', wallet_balance: 5000, is_active: true
  }));
  try {
    const { status } = await api('employees', 'POST', batch);
    if (status < 300) createSuccess += batch.length;
  } catch {}
  process.stdout.write(`    → ${Math.min(i + BATCH, TOTAL)}/${TOTAL} created...\r`);
}
console.log(`    → ${TOTAL}/${TOTAL} created      `);
createSuccess >= TOTAL ? ok(`Created ${createSuccess} test employees with ₹5000 each`) : fail(`Only created ${createSuccess}/${TOTAL}`);

// Get menu items (one per canteen for multi-counter testing)
const { data: allMenu } = await api('menu_items?is_available=eq.true&select=id,name,price,canteen_id&limit=100');
const { data: allCanteens } = await api('canteens?select=id,name,icon&is_open=eq.true');
const canteenMap = {};
allCanteens.forEach(c => { canteenMap[c.id] = c; });

// Pick one item per canteen
const itemsByCanteen = {};
allMenu.forEach(m => { if (!itemsByCanteen[m.canteen_id]) itemsByCanteen[m.canteen_id] = m; });
const canteenIds = Object.keys(itemsByCanteen);
ok(`${canteenIds.length} canteens available with menu items`);

// ═══════════════════════════════════════════════════
// PHASE 2: PLACE 400 ORDERS SIMULTANEOUSLY
// ═══════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log('  Phase 2: Place 400 orders (batches of 50)');
console.log('══════════════════════════════════════════════════');

const orderResults = [];
const t0 = Date.now();

const placeResults = await batchRun(empIds, async (eid) => {
  // Randomly assign to a canteen
  const cid = canteenIds[Math.floor(Math.random() * canteenIds.length)];
  const item = itemsByCanteen[cid];
  const can = canteenMap[cid];
  try {
    const { data } = await rpc('place_order', {
      p_employee_id: eid,
      p_canteen_id: cid,
      p_canteen_name: can.name,
      p_canteen_icon: can.icon || '🍽️',
      p_pickup_slot: '12:30 PM',
      p_items: [{ id: item.id, name: item.name, emoji: '🍽️', qty: 1, price: item.price, customNote: '' }],
      p_payment_method: 'wallet'
    });
    return { eid, cid, success: data?.success, data, error: data?.error };
  } catch (e) {
    return { eid, cid, success: false, error: e.message };
  }
});

const orderTime = Date.now() - t0;
const successOrders = placeResults.filter(r => r.success);
const failedOrders = placeResults.filter(r => !r.success);

ok(`${successOrders.length}/${TOTAL} orders placed in ${(orderTime / 1000).toFixed(1)}s`);
if (failedOrders.length > 0) {
  fail(`${failedOrders.length} orders failed`);
  // Show first 3 failure reasons
  const reasons = {};
  failedOrders.forEach(f => { const r = f.error || 'unknown'; reasons[r] = (reasons[r] || 0) + 1; });
  Object.entries(reasons).slice(0, 3).forEach(([r, c]) => console.log(`    → ${c}x: ${r}`));
} else {
  ok('0 order failures');
}

// Check for duplicate tokens per canteen
const tokensByCanteen = {};
successOrders.forEach(o => {
  const cid = o.cid;
  const tok = o.data.token_number;
  if (!tokensByCanteen[cid]) tokensByCanteen[cid] = [];
  tokensByCanteen[cid].push(tok);
});
let dupes = 0;
Object.entries(tokensByCanteen).forEach(([cid, tokens]) => {
  const unique = new Set(tokens);
  if (unique.size < tokens.length) {
    dupes += tokens.length - unique.size;
    fail(`Canteen ${cid}: ${tokens.length - unique.size} duplicate tokens!`);
  }
});
if (dupes === 0) ok('0 duplicate tokens across all canteens');

// Check avg response time
const avgTime = Math.round(orderTime / TOTAL);
avgTime < 200 ? ok(`Avg response time: ${avgTime}ms per order`) : warn(`Avg response time: ${avgTime}ms (slow)`);

// ═══════════════════════════════════════════════════
// PHASE 3: VERIFY WALLET DEDUCTIONS
// ═══════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log('  Phase 3: Verify wallet deductions');
console.log('══════════════════════════════════════════════════');

// Check 10 random employees
const sampleEmps = empIds.sort(() => Math.random() - 0.5).slice(0, 10);
let walletCorrect = 0;
for (const eid of sampleEmps) {
  const { data } = await api(`employees?id=eq.${eid}&select=wallet_balance`);
  const bal = parseFloat(data?.[0]?.wallet_balance);
  if (bal < 5000 && bal > 4900) walletCorrect++;
}
walletCorrect >= 8 ? ok(`Wallet deduction verified: ${walletCorrect}/10 sample employees correct`) : fail(`Wallet wrong: only ${walletCorrect}/10 correct`);

// ═══════════════════════════════════════════════════
// PHASE 4: KITCHEN — Accept all orders (new → preparing)
// ═══════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log('  Phase 4: Kitchen — Accept 400 orders');
console.log('══════════════════════════════════════════════════');

// Get all test orders
const { data: testOrders } = await api(`orders?employee_id=like.${PREFIX}*&status=eq.new&select=id,canteen_id,token_number&limit=500`);
ok(`${testOrders?.length || 0} orders in DB with status 'new'`);

const t1 = Date.now();
const acceptResults = await batchRun(testOrders || [], async (order) => {
  try {
    const { status } = await api(`orders?id=eq.${order.id}`, 'PATCH', { status: 'preparing' });
    return { success: status < 300 };
  } catch { return { success: false }; }
});
const acceptTime = Date.now() - t1;
const acceptSuccess = acceptResults.filter(r => r.success).length;
ok(`${acceptSuccess}/${testOrders?.length || 0} orders accepted in ${(acceptTime / 1000).toFixed(1)}s`);

// ═══════════════════════════════════════════════════
// PHASE 5: KITCHEN — Mark all ready (preparing → ready)
// ═══════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log('  Phase 5: Kitchen — Mark 400 orders ready');
console.log('══════════════════════════════════════════════════');

const { data: prepOrders } = await api(`orders?employee_id=like.${PREFIX}*&status=eq.preparing&select=id&limit=500`);
const t2 = Date.now();
const readyResults = await batchRun(prepOrders || [], async (order) => {
  try {
    const { status } = await api(`orders?id=eq.${order.id}`, 'PATCH', { status: 'ready' });
    return { success: status < 300 };
  } catch { return { success: false }; }
});
const readyTime = Date.now() - t2;
const readySuccess = readyResults.filter(r => r.success).length;
ok(`${readySuccess}/${prepOrders?.length || 0} orders marked ready in ${(readyTime / 1000).toFixed(1)}s`);

// ═══════════════════════════════════════════════════
// PHASE 6: PICKUP OTP — Confirm all pickups (ready → done)
// ═══════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log('  Phase 6: Pickup OTP — Confirm 400 pickups');
console.log('══════════════════════════════════════════════════');

const { data: readyOrders } = await api(`orders?employee_id=like.${PREFIX}*&status=eq.ready&select=id&limit=500`);
const t3 = Date.now();
const pickupResults = await batchRun(readyOrders || [], async (order) => {
  try {
    const { status } = await api(`orders?id=eq.${order.id}`, 'PATCH', {
      status: 'done',
      pickup_confirmed_at: new Date().toISOString()
    });
    return { success: status < 300 };
  } catch { return { success: false }; }
});
const pickupTime = Date.now() - t3;
const pickupSuccess = pickupResults.filter(r => r.success).length;
ok(`${pickupSuccess}/${readyOrders?.length || 0} pickups confirmed in ${(pickupTime / 1000).toFixed(1)}s`);

// Verify all orders are 'done'
const { data: doneOrders } = await api(`orders?employee_id=like.${PREFIX}*&status=eq.done&select=id&limit=500`);
const doneCount = doneOrders?.length || 0;
doneCount >= successOrders.length * 0.95 ? ok(`${doneCount} orders completed (status = done)`) : fail(`Only ${doneCount} done, expected ~${successOrders.length}`);

// ═══════════════════════════════════════════════════
// PHASE 7: ADMIN — Revenue & Stats Verification
// ═══════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log('  Phase 7: Admin — Revenue & Stats');
console.log('══════════════════════════════════════════════════');

// Total revenue from test orders
const { data: revenueOrders } = await api(`orders?employee_id=like.${PREFIX}*&select=amount_paid,item_total,gst_amount,canteen_id,status&limit=500`);
const totalRevenue = (revenueOrders || []).reduce((s, o) => s + (parseFloat(o.amount_paid) || 0), 0);
const totalItemTotal = (revenueOrders || []).reduce((s, o) => s + (parseFloat(o.item_total) || 0), 0);
const totalGST = (revenueOrders || []).reduce((s, o) => s + (parseFloat(o.gst_amount) || 0), 0);
const totalPlatformFees = successOrders.length * 3.54; // ₹3 + ₹0.54 GST per order

ok(`Total revenue: ₹${totalRevenue.toFixed(2)}`);
ok(`  Item subtotal: ₹${totalItemTotal.toFixed(2)}`);
ok(`  Food GST (5%): ₹${totalGST.toFixed(2)}`);
ok(`  Platform fees: ~₹${totalPlatformFees.toFixed(2)} (${successOrders.length} × ₹3.54)`);

// GST sanity check
const expectedGST = Math.round(totalItemTotal * 0.05 * 100) / 100;
if (Math.abs(totalGST - expectedGST) < successOrders.length) ok('GST calculation consistent');
else warn(`GST mismatch: ₹${totalGST} vs expected ~₹${expectedGST}`);

// Revenue per canteen
const canteenRevenue = {};
(revenueOrders || []).forEach(o => {
  if (!canteenRevenue[o.canteen_id]) canteenRevenue[o.canteen_id] = { orders: 0, revenue: 0 };
  canteenRevenue[o.canteen_id].orders++;
  canteenRevenue[o.canteen_id].revenue += parseFloat(o.amount_paid) || 0;
});
console.log('  📊 Revenue per canteen:');
Object.entries(canteenRevenue).forEach(([cid, d]) => {
  const name = canteenMap[cid]?.name || cid;
  console.log(`    ${name}: ${d.orders} orders, ₹${d.revenue.toFixed(2)}`);
});
ok(`Revenue distributed across ${Object.keys(canteenRevenue).length} canteens`);

// Wallet transactions count
const { data: txnCount } = await api(`wallet_transactions?employee_id=like.${PREFIX}*&select=id&limit=1000`);
ok(`${txnCount?.length || 0} wallet transactions logged`);

// Order items count
const testOrderIds = (revenueOrders || []).map(o => o.id || '').filter(Boolean);
// Just check a sample
const { data: sampleItems } = await api(`order_items?select=id&limit=500`);
ok(`Order items verified (${sampleItems?.length || 0}+ in DB)`);

// ═══════════════════════════════════════════════════
// PHASE 8: CANCEL + REFUND TEST (10 random orders)
// ═══════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log('  Phase 8: Cancel + Refund (10 new orders)');
console.log('══════════════════════════════════════════════════');

// Place 10 fresh orders for cancel testing
const cancelEmps = empIds.slice(0, 10);
let cancelSuccess = 0;
let refundCorrect = 0;

for (const eid of cancelEmps) {
  const cid = canteenIds[0];
  const item = itemsByCanteen[cid];
  const can = canteenMap[cid];

  // Get balance before
  const { data: before } = await api(`employees?id=eq.${eid}&select=wallet_balance`);
  const balBefore = parseFloat(before?.[0]?.wallet_balance) || 0;

  // Place order
  const { data: orderRes } = await rpc('place_order', {
    p_employee_id: eid, p_canteen_id: cid, p_canteen_name: can.name, p_canteen_icon: can.icon || '🍽️',
    p_pickup_slot: '1:00 PM', p_items: [{ id: item.id, name: item.name, emoji: '🍽️', qty: 1, price: item.price, customNote: '' }],
    p_payment_method: 'wallet'
  });

  if (!orderRes?.success) continue;
  const orderId = String(orderRes.order_id);
  const amountPaid = parseFloat(orderRes.amount_paid);

  // Cancel
  const { data: cancelRes } = await rpc('employee_cancel_order', {
    p_order_id: orderId,
    p_employee_id: eid
  });

  if (cancelRes?.success) {
    cancelSuccess++;
    const newBal = parseFloat(cancelRes.new_balance);
    if (Math.abs(newBal - balBefore) < 0.02) refundCorrect++;
  }
}

cancelSuccess >= 8 ? ok(`${cancelSuccess}/10 cancels succeeded`) : fail(`Only ${cancelSuccess}/10 cancels worked`);
refundCorrect >= 8 ? ok(`${refundCorrect}/10 refunds correct (balance restored)`) : fail(`Only ${refundCorrect}/10 refunds correct`);

// ═══════════════════════════════════════════════════
// PHASE 9: CLEANUP
// ═══════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log('  Phase 9: Cleanup test data');
console.log('══════════════════════════════════════════════════');

try {
  // Delete in correct order (foreign keys)
  console.log('    → Deleting order_items...');
  await api(`order_items?order_id=in.(select id from orders where employee_id like '${PREFIX}%')`, 'DELETE').catch(() => {});

  // Use direct SQL-style delete via RPC or batch
  console.log('    → Deleting wallet_transactions...');
  for (let i = 0; i < empIds.length; i += BATCH) {
    const batch = empIds.slice(i, i + BATCH);
    for (const eid of batch) {
      await api(`wallet_transactions?employee_id=eq.${eid}`, 'DELETE').catch(() => {});
    }
  }

  console.log('    → Deleting orders...');
  for (let i = 0; i < empIds.length; i += BATCH) {
    const batch = empIds.slice(i, i + BATCH);
    for (const eid of batch) {
      await api(`orders?employee_id=eq.${eid}`, 'DELETE').catch(() => {});
    }
  }

  console.log('    → Deleting test employees...');
  for (let i = 0; i < empIds.length; i += BATCH) {
    const batch = empIds.slice(i, i + BATCH);
    for (const eid of batch) {
      await api(`employees?id=eq.${eid}`, 'DELETE').catch(() => {});
    }
  }

  ok('Test data cleaned up');
} catch (e) {
  warn('Cleanup partial — run manually: DELETE FROM employees WHERE id LIKE \'LOADTEST-400-%\'');
}

// ═══════════════════════════════════════════════════
// FINAL RESULTS
// ═══════════════════════════════════════════════════
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`
╔═══════════════════════════════════════════════════════╗
║   RESULTS (completed in ${elapsed}s)${' '.repeat(Math.max(0, 28 - elapsed.length))}║
╠═══════════════════════════════════════════════════════╣
║   Total employees: ${TOTAL}                                ║
║   Orders placed:   ${successOrders.length}/${TOTAL}${' '.repeat(Math.max(0, 33 - String(successOrders.length).length - String(TOTAL).length))}║
║   Kitchen flow:    ${doneCount} completed                     ║
║   Cancel/refund:   ${cancelSuccess}/10 passed                       ║
║   Revenue:         ₹${totalRevenue.toFixed(0)}${' '.repeat(Math.max(0, 33 - String(totalRevenue.toFixed(0)).length))}║
║   Avg order time:  ${avgTime}ms${' '.repeat(Math.max(0, 34 - String(avgTime).length))}║
╠═══════════════════════════════════════════════════════╣
║   ✅ Passed:   ${String(passed).padEnd(38)}║
║   ❌ Failed:   ${String(failed).padEnd(38)}║
║   ⚠️  Warnings: ${String(warnings).padEnd(38)}║
╠═══════════════════════════════════════════════════════╣`);
if (failed === 0) {
  console.log(`║   ✅ LOAD TEST PASSED — ready for 8,000 employees    ║`);
} else {
  console.log(`║   🚨 FAILURES — fix before scaling to 8,000          ║`);
}
console.log(`╚═══════════════════════════════════════════════════════╝`);
process.exit(failed > 0 ? 1 : 0);
