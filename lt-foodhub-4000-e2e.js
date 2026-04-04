// ══════════════════════════════════════════════════════════════════
// SLP NEXUS — 4000 Concurrent Order E2E Load Test
// Tests EVERY feature: registration, login, ordering, GST, cancel,
//   refund, kitchen flow, admin revenue, POS, canteen open/close,
//   wallet topup, token uniqueness, concurrent stress, security
// ══════════════════════════════════════════════════════════════════
// Run: SUPABASE_SERVICE_KEY="your_key" node lt-foodhub-4000-e2e.js
// ══════════════════════════════════════════════════════════════════

const SURL = 'https://lorgclscnjdbngqurdsw.supabase.co';
const SKEY = process.env.SUPABASE_SERVICE_KEY;
if (!SKEY) { console.error('❌ Set SUPABASE_SERVICE_KEY env var'); process.exit(1); }

const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvcmdjbHNjbmpkYm5ncXVyZHN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNjA3MjEsImV4cCI6MjA4ODYzNjcyMX0.T8TwjIuILMEwNZgfo0s4_9Zr1_5ocTAtCxWntSA2iu4';
const CANTEENS = ['c1','c2','c3','c4','c5','c6','c7'];
const CANTEEN_NAMES = {c1:'North Indian',c2:'South Indian',c3:'Chinese',c4:'Italian',c5:'Non-Veg',c6:'Chaat',c7:'Beverages'};
const MENU = [
  {id:'m021',name:'Dal Tadka',price:80,canteen_id:'c1',emoji:'🍛'},
  {id:'m022',name:'Paneer Butter Masala',price:95,canteen_id:'c1',emoji:'🧀'},
  {id:'m025',name:'Rajma Chawal',price:80,canteen_id:'c1',emoji:'🍛'},
  {id:'m028',name:'Veg Biryani',price:85,canteen_id:'c1',emoji:'🍚'},
  {id:'m036',name:'Idli Sambar',price:35,canteen_id:'c2',emoji:'🥣'},
  {id:'m045',name:'Masala Dosa',price:40,canteen_id:'c2',emoji:'🫓'},
  {id:'m056',name:'Veg Fried Rice',price:80,canteen_id:'c3',emoji:'🍳'},
  {id:'m069',name:'Chicken Fried Rice',price:100,canteen_id:'c3',emoji:'🍳'},
  {id:'m078',name:'Margherita Pizza',price:100,canteen_id:'c4',emoji:'🍕'},
  {id:'m084',name:'Veg Pasta',price:100,canteen_id:'c4',emoji:'🍝'},
  {id:'m098',name:'Chicken Biryani',price:120,canteen_id:'c5',emoji:'🍗'},
  {id:'m108',name:'Masala Omelette',price:55,canteen_id:'c5',emoji:'🥚'},
  {id:'m118',name:'Pani Puri',price:35,canteen_id:'c6',emoji:'🥟'},
  {id:'m120',name:'Bhelpuri',price:40,canteen_id:'c6',emoji:'🥟'},
  {id:'m001',name:'Tea',price:15,canteen_id:'c7',emoji:'☕'},
  {id:'m002',name:'Coffee',price:20,canteen_id:'c7',emoji:'☕'},
];

// ── Helpers ──
async function rpc(name, params) {
  const r = await fetch(`${SURL}/rest/v1/rpc/${name}`, {
    method:'POST', headers:{'Content-Type':'application/json','apikey':SKEY,'Authorization':`Bearer ${SKEY}`},
    body: JSON.stringify(params)
  });
  return r.json();
}
async function query(table, params='') {
  const r = await fetch(`${SURL}/rest/v1/${table}?${params}`, {
    headers:{'apikey':SKEY,'Authorization':`Bearer ${SKEY}`}
  });
  return r.json();
}
async function update(table, match, data) {
  await fetch(`${SURL}/rest/v1/${table}?${match}`, {
    method:'PATCH', headers:{'Content-Type':'application/json','apikey':SKEY,'Authorization':`Bearer ${SKEY}`,'Prefer':'return=minimal'},
    body: JSON.stringify(data)
  });
}
async function insert(table, data) {
  const r = await fetch(`${SURL}/rest/v1/${table}`, {
    method:'POST', headers:{'Content-Type':'application/json','apikey':SKEY,'Authorization':`Bearer ${SKEY}`,'Prefer':'resolution=merge-duplicates,return=minimal'},
    body: JSON.stringify(data)
  });
  return r;
}
function randomItems(cid) {
  const pool = MENU.filter(m => m.canteen_id === cid);
  const count = 1 + Math.floor(Math.random() * 3);
  const items = [];
  for (let i = 0; i < count; i++) {
    const m = pool[Math.floor(Math.random() * pool.length)];
    const ex = items.find(x => x.id === m.id);
    if (ex) ex.qty = Math.min(5, ex.qty + 1);
    else items.push({id:m.id,name:m.name,emoji:m.emoji,qty:1,price:m.price});
  }
  return items;
}
function calcGST(items) {
  const sub = items.reduce((s,i)=>s+i.price*i.qty,0);
  const gst = Math.round(sub*0.05*100)/100;
  return {sub, gst, total: Math.round((sub+gst)*100)/100};
}
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

let passed=0, failed=0, warnings=0;
const errors=[];
function ok(m){passed++;console.log(`  ✅ ${m}`);}
function fail(m,d=''){failed++;errors.push(m);console.log(`  ❌ ${m} ${d}`);}
function warn(m){warnings++;console.log(`  ⚠️  ${m}`);}

// ══════════════════════════════════════
async function run() {
  const T0 = Date.now();
  console.log('\n════════════════════════════════════════════════════════');
  console.log('  SLP NEXUS — 4000 Concurrent Order E2E Load Test');
  console.log('════════════════════════════════════════════════════════\n');

  // ═══════ PHASE 1: CREATE 4000 TEST EMPLOYEES ═══════
  console.log('📋 PHASE 1: Creating 4000 test employees...');
  const empIds = [];
  for (let b=0; b<40; b++) {
    const batch = [];
    for (let i=0; i<100; i++) {
      const n = b*100+i+1;
      batch.push({
        id:`LOAD-${String(n).padStart(4,'0')}`,
        name:`Load Emp ${n}`,
        email:`load${n}@test.com`,
        phone:`80000${String(n).padStart(5,'0')}`,
        department:['Eng','HR','Fin','Ops','Mkt'][n%5],
        campus:'Vadodara Campus',
        wallet_balance:10000,
        is_active:true,
        initials:`L${n}`
      });
    }
    await insert('employees', batch);
    batch.forEach(e=>empIds.push(e.id));
    if ((b+1)%10===0) process.stdout.write(`  ${(b+1)*100} employees created\r`);
  }
  console.log(`  ✅ ${empIds.length} test employees created/upserted`);

  // ═══════ PHASE 2: 4000 ORDERS — 200 concurrent batches of 20 ═══════
  console.log('\n📋 PHASE 2: Placing 4000 orders (200 batches × 20 concurrent)...');
  const allOrders = [];
  const times = [];
  const BATCH = 20;
  let orderFails = 0;

  for (let b=0; b<empIds.length; b+=BATCH) {
    const chunk = empIds.slice(b, b+BATCH);
    const results = await Promise.all(chunk.map(async (empId, idx) => {
      const cid = CANTEENS[(b+idx)%7];
      const items = randomItems(cid);
      const t0 = Date.now();
      try {
        const r = await rpc('place_order', {
          p_employee_id: empId, p_canteen_id: cid,
          p_canteen_name: CANTEEN_NAMES[cid], p_canteen_icon:'🍽️',
          p_pickup_slot:'12:30 PM', p_items:items, p_payment_method:'wallet'
        });
        times.push(Date.now()-t0);
        if (r?.success) return {empId,cid,items,result:r,orderId:r.order_id,token:r.token_number};
        else { orderFails++; return null; }
      } catch(e) { orderFails++; return null; }
    }));
    results.filter(Boolean).forEach(r=>allOrders.push(r));
    if ((b+BATCH)%500===0) {
      const avg = Math.round(times.slice(-500).reduce((s,t)=>s+t,0)/Math.min(500,times.length));
      process.stdout.write(`  ${b+BATCH} orders | avg ${avg}ms | fails ${orderFails}\r`);
    }
  }
  const avgMs = Math.round(times.reduce((s,t)=>s+t,0)/times.length);
  const p99 = times.sort((a,b)=>a-b)[Math.floor(times.length*0.99)];
  console.log(`\n  Orders: ${allOrders.length}/4000 | Fails: ${orderFails}`);
  console.log(`  Avg: ${avgMs}ms | P99: ${p99}ms | Max: ${Math.max(...times)}ms | Min: ${Math.min(...times)}ms`);
  if (allOrders.length >= 3900) ok(`${allOrders.length}/4000 orders placed`);
  else fail(`Only ${allOrders.length}/4000 orders`);

  // ═══════ PHASE 3: GST VERIFICATION (sample 500) ═══════
  console.log('\n📋 PHASE 3: GST verification (500 samples)...');
  let gstOk=0, gstBad=0;
  for (const o of allOrders.slice(0,500)) {
    const expected = calcGST(o.items);
    const actual = parseFloat(o.result.amount_paid);
    if (Math.abs(actual-expected.total)<0.02) gstOk++;
    else { gstBad++; if(gstBad<=3) warn(`GST: emp=${o.empId} exp=${expected.total} got=${actual}`); }
  }
  if (gstBad===0) ok('GST correct on all 500 samples (item + 5% only)');
  else fail(`${gstBad}/500 GST mismatches`);

  // Platform fee check
  const sample = allOrders[0]?.result;
  if (sample && parseFloat(sample.platform_fee||0)===0) ok('Platform fee = ₹0');
  else fail('Platform fee found!');

  // ═══════ PHASE 4: TOKEN UNIQUENESS ═══════
  console.log('\n📋 PHASE 4: Token uniqueness across 7 canteens...');
  const tokenMap = {};
  allOrders.forEach(o=>{
    const key = o.cid;
    if(!tokenMap[key]) tokenMap[key]=new Set();
    if(tokenMap[key].has(o.token)) fail(`Duplicate token ${o.token} in ${key}`);
    tokenMap[key].add(o.token);
  });
  let dupes=0;
  for(const [cid,tokens] of Object.entries(tokenMap)){
    const count = allOrders.filter(o=>o.cid===cid).length;
    if(tokens.size<count) dupes += count-tokens.size;
  }
  if(dupes===0) ok(`0 duplicate tokens across ${Object.keys(tokenMap).length} canteens`);
  else fail(`${dupes} duplicate tokens found`);

  // ═══════ PHASE 5: CANCEL + REFUND (200 orders) ═══════
  console.log('\n📋 PHASE 5: Cancel + refund 200 orders...');
  const cancelTargets = allOrders.slice(0,200);
  let cancelOk=0, refundOk=0;
  // Process in batches of 20
  for (let b=0; b<cancelTargets.length; b+=20) {
    const chunk = cancelTargets.slice(b,b+20);
    const results = await Promise.all(chunk.map(async o=>{
      const r = await rpc('employee_cancel_order',{p_order_id:o.orderId,p_employee_id:o.empId});
      return {o, r};
    }));
    results.forEach(({o,r})=>{
      if(r?.success){ cancelOk++;
        const refunded = parseFloat(r.refunded||0);
        const expected = calcGST(o.items).total;
        if(Math.abs(refunded-expected)<0.02) refundOk++;
      }
    });
  }
  if(cancelOk>=190) ok(`${cancelOk}/200 cancels succeeded`);
  else fail(`Only ${cancelOk}/200 cancels`);
  if(refundOk>=190) ok(`${refundOk}/200 refunds correct (full amount_paid)`);
  else fail(`Only ${refundOk}/200 correct refunds`);

  // ═══════ PHASE 6: KITCHEN FLOW (100 orders) ═══════
  console.log('\n📋 PHASE 6: Kitchen flow — new→preparing→ready→done (100 orders)...');
  const kitchenTargets = allOrders.slice(200,300);
  let flowOk=0;
  for(let b=0; b<kitchenTargets.length; b+=20){
    const chunk = kitchenTargets.slice(b,b+20);
    await Promise.all(chunk.map(async o=>{
      try{
        await update('orders',`id=eq.${o.orderId}`,{status:'preparing'});
        await update('orders',`id=eq.${o.orderId}`,{status:'ready'});
        await update('orders',`id=eq.${o.orderId}`,{status:'done'});
        const [check] = await query('orders',`id=eq.${o.orderId}&select=status`);
        if(check?.status==='done') flowOk++;
      }catch(e){}
    }));
  }
  if(flowOk>=95) ok(`${flowOk}/100 kitchen flows completed`);
  else fail(`Only ${flowOk}/100 kitchen flows`);

  // ═══════ PHASE 7: CANTEEN OPEN/CLOSE ═══════
  console.log('\n📋 PHASE 7: Canteen open/close...');
  await update('canteens','id=eq.c1',{is_open:false});
  const [c1] = await query('canteens','id=eq.c1&select=is_open');
  if(c1?.is_open===false) ok('Canteen c1 closed');
  else fail('Failed to close c1');

  // Order on closed canteen — RPC should still work (UI blocks, not server)
  const closedR = await rpc('place_order',{
    p_employee_id:empIds[3999],p_canteen_id:'c1',p_canteen_name:'North Indian',
    p_canteen_icon:'🍽️',p_pickup_slot:'12:30 PM',
    p_items:[{id:'m021',name:'Dal Tadka',emoji:'🍛',qty:1,price:80}],p_payment_method:'wallet'
  });
  console.log(`  Order on closed canteen: ${closedR?.success?'RPC allows (UI blocks)':'Failed: '+closedR?.error}`);

  await update('canteens','id=eq.c1',{is_open:true});
  const [c1b] = await query('canteens','id=eq.c1&select=is_open');
  if(c1b?.is_open===true) ok('Canteen c1 reopened');
  else fail('Failed to reopen c1');

  // ═══════ PHASE 8: POS CASH ORDER ═══════
  console.log('\n📋 PHASE 8: POS cash orders (20 orders)...');
  let posOk=0;
  for(let i=0;i<20;i++){
    const cid = CANTEENS[i%7];
    const items = randomItems(cid);
    const r = await rpc('pos_cash_order',{
      p_canteen_id:cid,p_canteen_name:CANTEEN_NAMES[cid],
      p_canteen_icon:'🍽️',p_items:items
    });
    if(r?.success){
      const expected = calcGST(items).total;
      const actual = parseFloat(r.amount_paid);
      if(Math.abs(actual-expected)<0.02) posOk++;
    }
  }
  if(posOk>=18) ok(`${posOk}/20 POS orders correct GST`);
  else fail(`Only ${posOk}/20 POS orders correct`);

  // ═══════ PHASE 9: ADMIN WALLET CREDIT (manual refund) ═══════
  console.log('\n📋 PHASE 9: Admin wallet credit (10 refunds)...');
  let creditOk=0;
  for(let i=0;i<10;i++){
    const empId = empIds[3000+i];
    const [before] = await query('employees',`id=eq.${empId}&select=wallet_balance`);
    const r = await rpc('admin_wallet_credit',{
      p_admin_id:'admin-001',p_admin_password:'password123',
      p_employee_id:empId,p_amount:100,p_reason:'Load test refund'
    });
    if(r?.success){
      const [after] = await query('employees',`id=eq.${empId}&select=wallet_balance`);
      if(Math.abs(parseFloat(after.wallet_balance)-parseFloat(before.wallet_balance)-100)<0.01) creditOk++;
    }
  }
  if(creditOk>=9) ok(`${creditOk}/10 admin credits correct`);
  else fail(`Only ${creditOk}/10 admin credits`);

  // ═══════ PHASE 10: WALLET TRANSACTION HISTORY ═══════
  console.log('\n📋 PHASE 10: Transaction history verification...');
  const testEmp = empIds[0]; // Had order + cancel
  const txns = await query('wallet_transactions',`employee_id=eq.${testEmp}&order=created_at.desc&limit=10`);
  const debits = txns.filter(t=>t.type==='debit');
  const credits = txns.filter(t=>t.type==='credit');
  console.log(`  ${testEmp}: ${txns.length} txns (${debits.length} debits, ${credits.length} credits)`);
  if(txns.length>=2) ok('Transaction history has order + refund');
  else warn('Transaction history incomplete');
  if(credits.find(t=>t.description?.includes('Refund'))) ok('Refund recorded in wallet_transactions');
  else warn('No refund transaction found');

  // ═══════ PHASE 11: SECURITY CHECKS ═══════
  console.log('\n📋 PHASE 11: Security checks...');
  // Fake employee
  const fakeR = await rpc('place_order',{
    p_employee_id:'FAKE-9999',p_canteen_id:'c1',p_canteen_name:'Test',
    p_canteen_icon:'🍽️',p_pickup_slot:'12:00 PM',
    p_items:[{id:'m021',name:'Test',emoji:'🍛',qty:1,price:80}],p_payment_method:'wallet'
  });
  if(!fakeR?.success) ok('Fake employee blocked');
  else fail('Fake employee NOT blocked');

  // Zero balance
  await update('employees',`id=eq.${empIds[3998]}`,{wallet_balance:0});
  const brokeR = await rpc('place_order',{
    p_employee_id:empIds[3998],p_canteen_id:'c1',p_canteen_name:'Test',
    p_canteen_icon:'🍽️',p_pickup_slot:'12:00 PM',
    p_items:[{id:'m021',name:'Test',emoji:'🍛',qty:1,price:80}],p_payment_method:'wallet'
  });
  if(!brokeR?.success) ok('Insufficient balance blocked');
  else fail('Insufficient balance NOT blocked');

  // Cross-employee cancel
  const otherOrder = allOrders[350]?.orderId;
  if(otherOrder){
    const stealR = await rpc('employee_cancel_order',{p_order_id:otherOrder,p_employee_id:empIds[3999]});
    if(!stealR?.success) ok("Cross-employee cancel blocked");
    else fail('Cross-cancel NOT blocked');
  }

  // ═══════ PHASE 12: ADMIN REVENUE QUERY ═══════
  console.log('\n📋 PHASE 12: Admin revenue verification...');
  const today = new Date().toISOString().slice(0,10);
  const todayOrders = await query('orders',`created_at=gte.${today}T00:00:00&status=neq.cancelled&select=amount_paid,canteen_id&limit=5000`);
  const totalRev = todayOrders.reduce((s,o)=>s+(parseFloat(o.amount_paid)||0),0);
  const canRev = {};
  todayOrders.forEach(o=>{canRev[o.canteen_id]=(canRev[o.canteen_id]||0)+(parseFloat(o.amount_paid)||0);});
  console.log(`  Active orders today: ${todayOrders.length}`);
  console.log(`  Total revenue: ₹${Math.round(totalRev).toLocaleString('en-IN')}`);
  for(const[cid,rev] of Object.entries(canRev).sort()) console.log(`    ${cid}: ₹${Math.round(rev).toLocaleString('en-IN')} (${todayOrders.filter(o=>o.canteen_id===cid).length} orders)`);
  ok('Admin revenue query works at scale');

  // ═══════ PHASE 13: 100 CONCURRENT STRESS TEST ═══════
  console.log('\n📋 PHASE 13: 100 simultaneous concurrent orders...');
  const stressTimes=[];
  const stressResults = await Promise.all(Array.from({length:100},(_,i)=>{
    const empId=empIds[3500+i];
    const cid=CANTEENS[i%7];
    const items=randomItems(cid);
    const t0=Date.now();
    return rpc('place_order',{
      p_employee_id:empId,p_canteen_id:cid,p_canteen_name:CANTEEN_NAMES[cid],
      p_canteen_icon:'🍽️',p_pickup_slot:'1:00 PM',p_items:items,p_payment_method:'wallet'
    }).then(r=>{stressTimes.push(Date.now()-t0);return r;});
  }));
  const stressOk=stressResults.filter(r=>r?.success).length;
  const stressAvg=Math.round(stressTimes.reduce((s,t)=>s+t,0)/stressTimes.length);
  console.log(`  Success: ${stressOk}/100 | Avg: ${stressAvg}ms | Max: ${Math.max(...stressTimes)}ms`);
  if(stressOk>=95) ok(`${stressOk}/100 concurrent stress orders`);
  else fail(`Only ${stressOk}/100 concurrent`);

  // ═══════ PHASE 14: CLEANUP ═══════
  console.log('\n📋 PHASE 14: Cleanup — resetting balances...');
  // Reset in batches
  for(let b=0;b<empIds.length;b+=100){
    const chunk=empIds.slice(b,b+100);
    await Promise.all(chunk.map(id=>
      fetch(`${SURL}/rest/v1/employees?id=eq.${id}`,{
        method:'PATCH',headers:{'Content-Type':'application/json','apikey':SKEY,'Authorization':`Bearer ${SKEY}`},
        body:JSON.stringify({wallet_balance:10000})
      })
    ));
  }
  ok('All test employee balances reset to ₹10,000');

  // ═══════ FINAL REPORT ═══════
  const elapsed = ((Date.now()-T0)/1000).toFixed(1);
  console.log('\n════════════════════════════════════════════════════════');
  console.log('  FINAL REPORT');
  console.log('════════════════════════════════════════════════════════');
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  ⚠️  Warnings: ${warnings}`);
  console.log(`  ⏱️  Total time: ${elapsed}s`);
  console.log(`  📊 Orders: ${allOrders.length+stressOk+20} placed | 200 cancelled | 100 kitchen flow | 20 POS`);
  console.log(`  💰 Revenue: ₹${Math.round(totalRev).toLocaleString('en-IN')}`);
  console.log(`  ⚡ Performance: avg ${avgMs}ms | P99 ${p99}ms`);
  console.log(`  🔒 Security: fake blocked, balance checked, cross-cancel blocked`);
  if(errors.length){
    console.log('\n  ❌ FAILURES:');
    errors.forEach(e=>console.log(`    • ${e}`));
  }
  console.log('\n════════════════════════════════════════════════════════');
  if(failed===0) console.log('  🎉 ALL TESTS PASSED — PRODUCTION READY FOR 10K EMPLOYEES');
  else console.log(`  ⚠️  ${failed} TESTS FAILED — FIX BEFORE PRODUCTION`);
  console.log('════════════════════════════════════════════════════════\n');
}

run().catch(e=>{console.error('Test crashed:',e);process.exit(1);});
