const fs=require('fs'),https=require('https'),cron=require('node-cron');
const ak=fs.readFileSync('50446028_appkey.txt','utf8').trim();
const sk=fs.readFileSync('50446028_secretkey.txt','utf8').trim();
const TOKEN='8884127980:AAFdytRmoUhEbkaT3ezLpoxuT_hp3orjukA';
const CHAT_ID='7375098865';
const NAVER_ID='1HOZYX2umpM7Jt1PbwY1';
const NAVER_SECRET='lI7acJIUCx';
const THEMES={
'증권':['증권','투자증권','자산운용'],
'보험':['보험','화재','생명','손해'],
'바이오':['바이오','제약','헬스','메디','파마'],
'반도체':['반도체','하이닉스','실리콘','칩'],
'2차전지':['배터리','에코프로','엔솔','포스코','양극재'],
'AI':['AI','인공지능','클라우드','로봇'],
'건설':['건설','건축','주택'],
'철강':['철강','스틸','제철'],
'화학':['화학','케미칼','케미','소재'],
'금융':['금융','은행','캐피탈','카드'],
'방산':['방산','항공','우주','방위'],
'엔터':['엔터','미디어','콘텐츠','게임'],
'음식료':['식품','음료','주류'],
'에너지':['에너지','전력','태양광','수소'],
'IT':['IT','소프트웨어','플랫폼','솔루션'],
'자동차':['자동차','모터스','부품','타이어'],
'조선':['조선','중공업','선박'],
'ETF':['TIGER','KODEX','RISE','PLUS','ACE','SOL'],
};
function rq(o,b){return new Promise((rs,rj)=>{const r=https.request(o,p=>{let d='';p.on('data',c=>d+=c);p.on('end',()=>rs(d));});r.on('error',rj);if(b)r.write(b);r.end();});}
function sendTelegram(text){const b=JSON.stringify({chat_id:CHAT_ID,text:text});return rq({hostname:'api.telegram.org',port:443,path:'/bot'+TOKEN+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)}},b);}
async function getToken(){
const tb=JSON.stringify({grant_type:'client_credentials',appkey:ak,secretkey:sk});
return JSON.parse(await rq({hostname:'api.kiwoom.com',port:443,path:'/oauth2/token',method:'POST',headers:{'Content-Type':'application/json;charset=UTF-8','Content-Length':Buffer.byteLength(tb)}},tb)).token;
}
async function getVolumeTop(token,mrkt){
const sb=JSON.stringify({mrkt_tp:mrkt,sort_tp:'1',stex_tp:'3',cycle_tp:'1',trde_qty_tp:'5'});
const sr=await rq({hostname:'api.kiwoom.com',port:443,path:'/api/dostk/stkinfo',method:'POST',headers:{'Content-Type':'application/json;charset=UTF-8','Content-Length':Buffer.byteLength(sb),'Authorization':'Bearer '+token,'appkey':ak,'api-id':'ka10024'}},sb);
return JSON.parse(sr).trde_qty_updt||[];
}
async function getNews(keyword){
try{
const sr=await rq({hostname:'openapi.naver.com',port:443,path:'/v1/search/news.json?query='+encodeURIComponent(keyword+'주식')+'&display=3&sort=date',method:'GET',headers:{'X-Naver-Client-Id':NAVER_ID,'X-Naver-Client-Secret':NAVER_SECRE     async function scanMarket(token,mrkt,mrktName){
const volTop=await getVolumeTop(token,mrkt);
const rising=volTop.filter(s=>s.cur_prc&&s.cur_prc.startsWith('+'));
const scored=rising.map(s=>{
let score=0;
const qty=parseFloat(s.now_trde_qty)||0;
const chgPct=s.flu_rt||'0';
const chgNum=parseFloat(chgPct)||0;
const chdNum=parseFloat(s.cntr_str||'0')||0;
if(qty>100000)score++;
if(qty>200000)score++;
if(chgNum>3)score++;
if(chgNum>5)score++;
if(chdNum>120)score++;
const theme=getTheme(s.stk_nm);
const pullback=chgNum>0&&chgNum<2&&qty>100000;
return {...s,score,theme,chgPct,pullback,chdNum};
}).sort((a,b)=>b.score-a.score);
const themeCnt={};
scored.forEach(s=>{
if(s.theme!=='기타'&&s.theme!=='ETF'){
themeCnt[s.theme]=(themeCnt[s.theme]||0)+1;
}
});
const topThemes=Object.entries(themeCnt).sort((a,b)=>b[1]-a[1]).slice(0,3);
const topThemeName=topThemes.length>0?topThemes[0][0]:'주식';
const news=await getNews(topThemeName);
let msg='🔥 '+mrktName+' 대장주\n\n';
msg+='🎯 대장 테마\n';
topThemes.forEach((t,i)=>{msg+=(i+1)+'위. '+t[0]+' ('+t[1]+'개)\n';});
if(news.length>0){
msg+='\n📰 '+topThemeName+' 뉴스\n';
news.forEach(n=>{msg+='• '+n+'\n';});
}
msg+='\n📊 TOP 10\n\n';
scored.slice(0,10).forEach((s,i)=>{
const pb=s.pullback?'📉눌림목 ':'';
const cs=s.chdNum>120?'💥체결강도 ':'';
msg+=(i+1)+'위.['+s.theme+'] '+s.stk_nm+' '+pb+cs+'\n';
msg+='   '+s.cur_prc+' | '+s.chgPct+'% | '+s.now_trde_qty+'\n\n';
});
return msg;
}
async function scan(){
const token=await getToken();
const kospiMsg=await scanMarket(token,'0','코스피');
const kosdaqMsg=await scanMarket(token,'10','코스닥');
await sendTelegram(kospiMsg);
await sendTelegram(kosdaqMsg);
console.log(kospiMsg);
console.log(kosdaqMsg);
console.log('전송완료!');
}
cron.schedule('40 7 * * 1-5',scan,{timezone:'Asia/Seoul'});
cron.schedule('50 8 * * 1-5',scan,{timezone:'Asia/Seoul'});
cron.schedule('0 15 * * 1-5',scan,{timezone:'Asia/Seoul'});
console.log('스캐너 시작! 7:40/8:50/15:00');
scan();