import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS, GET"};
const ICICI_URL="https://pgpayuat.icicibank.com/tsp/pg/api/v2/initiateSale";
const MID=Deno.env.get("ICICI_MERCHANT_ID")||"100000000007164";
const AID=Deno.env.get("ICICI_AGGREGATOR_ID")||"A100000000007164";
const SECK=Deno.env.get("ICICI_SECURE_KEY")||"db06cca0-838b-4e01-8b20-6ac446ffb6bd";
const SU=Deno.env.get("SUPABASE_URL")||"https://lorgclscnjdbngqurdsw.supabase.co";
const SK=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
const WEB_URL="https://slp-nexus.vercel.app";
const APP_SCHEME="slpnexus";
async function hm(msg,key){const e=new TextEncoder();const k=await crypto.subtle.importKey("raw",e.encode(key),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const s=await crypto.subtle.sign("HMAC",k,e.encode(msg));return Array.from(new Uint8Array(s)).map(b=>b.toString(16).padStart(2,"0")).join("");}
function fd(){const n=new Date();return n.getFullYear()+String(n.getMonth()+1).padStart(2,"0")+String(n.getDate()).padStart(2,"0")+String(n.getHours()).padStart(2,"0")+String(n.getMinutes()).padStart(2,"0")+String(n.getSeconds()).padStart(2,"0");}
serve(async(req)=>{
if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
try{
let bp={};
if(req.method==="POST"){
try{
const ct=req.headers.get("content-type")||"";
if(ct.includes("json")){bp=await req.json();}
else{const t=await req.text();try{bp=JSON.parse(t);}catch{bp=Object.fromEntries(new URLSearchParams(t));}}
}catch(e){console.log("parse err",e);}
}
const isCB=bp.merchantTxnNo&&!bp.action;
if(isCB){
console.log("ICICI callback:",JSON.stringify(bp));
const txn=bp.merchantTxnNo||"";
const rc=bp.responseCode||"";
const ts=(bp.transactionStatus||"").toUpperCase();
const emp=bp.addlParam1||"";
const amt=parseFloat(bp.amount)||0;
const SUCCESS_CODES=["000","0000"];
const isSuccess=SUCCESS_CODES.includes(rc)||ts==="SUCCESS"||ts==="SUC";
console.log("Check: rc="+rc+", ts="+ts+", isSuccess="+isSuccess+", emp="+emp+", amt="+amt);
if(isSuccess&&emp&&amt>0&&SK){
try{
const sb=createClient(SU,SK);
const{data:e2}=await sb.from("employees").select("wallet_balance").eq("id",emp).single();
if(e2){
const nb=(parseFloat(e2.wallet_balance)||0)+amt;
await sb.from("employees").update({wallet_balance:nb}).eq("id",emp);
await sb.from("wallet_transactions").insert({employee_id:emp,type:"credit",amount:amt,description:"ICICI Wallet Top-up TxnNo:"+txn,balance_after:nb});
console.log("CREDITED:",emp,"+",amt,"=",nb);
}else{console.log("Emp not found:",emp);}
}catch(e){console.log("Credit err:",e);}
}else{
console.log("NOT crediting — payment failed or missing data");
}
const status=isSuccess?"success":"failed";
const params="payment="+status+"&txnNo="+txn+"&amt="+amt;
const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment ${status}</title>
<script>
// Try custom scheme first (opens app), fallback to web after 2s
var appUrl="${APP_SCHEME}://payment?${params}";
var webUrl="${WEB_URL}?${params}";
window.location.href=appUrl;
setTimeout(function(){window.location.href=webUrl;},2000);
</script></head><body><p>Redirecting...</p></body></html>`;
return new Response(html,{status:200,headers:{"Content-Type":"text/html"}});
}
const action=bp.action;
if(action==="initiate"){
const{amount,employeeId,employeeName,employeeEmail,employeePhone}=bp;
if(!amount||!employeeId)return new Response(JSON.stringify({success:false,error:"Missing params"}),{headers:{...CORS,"Content-Type":"application/json"}});
const txn="SLP"+Date.now()+Math.floor(Math.random()*1000);
const td=fd();
const amt=parseFloat(amount).toFixed(2);
const cb=SU+"/functions/v1/icici-payment";
const em=employeeEmail||"noreply@slpnexus.com";
const ph=employeePhone||"9999999999";
const nm=employeeName||"Employee";
const ht=employeeId+"TOPUP"+AID+amt+"356"+em+ph+nm+MID+txn+"0"+cb+"SALE"+td;
const sh=await hm(ht,SECK);
const pl={merchantId:MID,aggregatorID:AID,merchantTxnNo:txn,amount:amt,currencyCode:"356",payType:"0",customerEmailID:em,transactionType:"SALE",returnURL:cb,txnDate:td,customerMobileNo:ph,customerName:nm,addlParam1:employeeId,addlParam2:"TOPUP",secureHash:sh};
console.log("ICICI req:",JSON.stringify(pl));
let d;
try{
const r=await fetch(ICICI_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pl)});
const txt=await r.text();
console.log("ICICI raw:",txt.substring(0,200));
try{d=JSON.parse(txt);}catch{return new Response(JSON.stringify({success:false,error:"ICICI server unavailable. Try again later."}),{headers:{...CORS,"Content-Type":"application/json"}});}
}catch(e){return new Response(JSON.stringify({success:false,error:"Cannot reach ICICI: "+e.message}),{headers:{...CORS,"Content-Type":"application/json"}});}
console.log("ICICI res:",JSON.stringify(d));
if(d.responseCode==="R1000"&&d.redirectURI&&d.tranCtx){
return new Response(JSON.stringify({success:true,redirectUrl:d.redirectURI+"?tranCtx="+d.tranCtx,merchantTxnNo:txn}),{headers:{...CORS,"Content-Type":"application/json"}});
}
return new Response(JSON.stringify({success:false,error:"ICICI:"+(d.responseCode||"Err"),details:d}),{headers:{...CORS,"Content-Type":"application/json"}});
}
if(action==="checkBalance"){
const{employeeId}=bp;
if(!employeeId||!SK)return new Response(JSON.stringify({success:false}),{headers:{...CORS,"Content-Type":"application/json"}});
const sb=createClient(SU,SK);
const{data:e2}=await sb.from("employees").select("wallet_balance").eq("id",employeeId).single();
return new Response(JSON.stringify({success:true,balance:e2?parseFloat(e2.wallet_balance):0}),{headers:{...CORS,"Content-Type":"application/json"}});
}
return new Response(JSON.stringify({success:false,error:"Unknown"}),{headers:{...CORS,"Content-Type":"application/json"}});
}catch(e){return new Response(JSON.stringify({success:false,error:e.message}),{status:500,headers:{...CORS,"Content-Type":"application/json"}});}
});
