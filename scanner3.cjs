const fs=require('fs'),https=require('https');
const ak=fs.readFileSync('50446028_appkey.txt','utf8').trim();
const sk=fs.readFileSync('50446028_secretkey.txt','utf8').trim();
const TOKEN='8884127980:AAFdytRmoUhEbkaT3ezLpoxuT_hp3orjukA';
const CHAT_ID='7375098865';
function rq(o,b){return new Promise((rs,rj)=>{const r=https.request(o,p=>{let d='';p.on('data',c=>d+=c);p.on('end',()=>rs(d));});r.on('error',rj);if(b)r.write(b);r.end();});}
function sendTelegram(text){const b=JSON.stringify({chat_id:CHAT_ID,text:text});return rq({hostname:'api.telegram.org',port:443,path:'/bot'+TOKEN+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)}},b);}
async function main(){
const tb=JSON.stringify({grant_type:'client_credentials',appkey:ak,secretkey:sk});
const t=JSON.parse(await rq({hostname:'api.kiwoom.com',port:443,path:'/oauth2/token',method:'POST',headers:{'Content-Type':'application/json;charset=UTF-8','Content-Length':Buffer.byteLength(tb)}},tb)).token;
const sb=JSON.stringify({mrkt_tp:'10',sort_tp:'1',stex_tp:'3',cycle_tp:'1',trde_qty_tp:'5'});
const sr=await rq({hostname:'api.kiwoom.com',port:443,path:'/api/dostk/stkinfo',method:'POST',headers:{'Content-Type':'application/json;charset=UTF-8','Content-Length':Buffer.byteLength(sb),'Authorization':'Bearer '+t,'appkey':ak,'api-id':'ka10024'}},sb);
const res=JSON.parse(sr);
const list=res.trde_qty_updt||res.stk_trde_qty_upper||[];
let msg='=== 거래량 급등 TOP 10 ===\n';
list.slice(0,10).forEach((s,i)=>{msg+=(i+1)+'위. '+s.stk_nm+' | '+s.cur_prc+' | '+s.now_trde_qty+'\n';});
console.log(msg);
await sendTelegram(msg);
console.log('텔레그램 전송 완료!');
}
main();