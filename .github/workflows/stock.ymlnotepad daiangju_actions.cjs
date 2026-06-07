const https = require('https');
const http = require('http');

const ak = process.env.APPKEY;
const sk = process.env.SECRETKEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

// 현재 시간 (한국시간 기준)
const now = new Date();
const hour = parseInt(new Date(now.toLocaleString('en-US', {timeZone: 'Asia/Seoul'})).getHours());
const min = parseInt(new Date(now.toLocaleString('en-US', {timeZone: 'Asia/Seoul'})).getMinutes());

function rq(o, b) {
  return new Promise((res, rej) => {
    const r = https.request(o, p => {
      let d = '';
      p.on('data', c => d += c);
      p.on('end', () => res(d));
    });
    r.on('error', rej);
    if (b) r.write(b);
    r.end();
  });
}

function httpGet(url) {
  return new Promise((res, rej) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8'
      }
    }, p => {
      if (p.statusCode === 301 || p.statusCode === 302) {
        return httpGet(p.headers.location).then(res).catch(rej);
      }
      const chunks = [];
      p.on('data', c => chunks.push(c));
      p.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', rej);
    req.setTimeout(8000, () => { req.destroy(); rej(new Error('timeout')); });
  });
}

async function getToken() {
  const tb = JSON.stringify({ grant_type: 'client_credentials', appkey: ak, secretkey: sk });
  const res = JSON.parse(await rq({
    hostname: 'api.kiwoom.com', port: 443, path: '/oauth2/token', method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Content-Length': Buffer.byteLength(tb) }
  }, tb));
  return res.token;
}

async function getVolumeTop(token, mrkt_tp) {
  const body = JSON.stringify({
    mrkt_tp, sort_tp: '1', mang_stk_incls: '0',
    crd_tp: '0', trde_qty_tp: '0', pric_tp: '0',
    trde_prica_tp: '0', mrkt_open_tp: '0', stex_tp: '3'
  });
  const res = await rq({
    hostname: 'api.kiwoom.com', port: 443, path: '/api/dostk/rkinfo', method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': 'Bearer ' + token,
      'appkey': ak, 'api-id': 'ka10030'
    }
  }, body);
  const data = JSON.parse(res);
  return data.tdy_trde_qty_upper || [];
}

async function getDailyCandles(token, stk_cd) {
  try {
    const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
    const body = JSON.stringify({ stk_cd, base_dt: today, upd_stkpc_tp: '1' });
    const res = await rq({
      hostname: 'api.kiwoom.com', port: 443, path: '/api/dostk/chart', method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + token,
        'appkey': ak, 'api-id': 'ka10082'
      }
    }, body);
    const data = JSON.parse(res);
    return data.stk_dt_pole_chart_qry || [];
  } catch(e) { return []; }
}

function analyzeDailyPattern(candles) {
  if (candles.length < 2) return { label: '', score: 0, pattern: 'none' };
  const today = candles[0];
  const yesterday = candles[1];
  const todayOpen = parseFloat(today.open_pric) || 0;
  const todayClose = parseFloat(today.cur_prc) || 0;
  const todayHigh = parseFloat(today.high_pric) || 0;
  const todayVol = parseFloat(today.trde_qty) || 0;
  const prevOpen = parseFloat(yesterday.open_pric) || 0;
  const prevClose = parseFloat(yesterday.cur_prc) || 0;
  const prevHigh = parseFloat(yesterday.high_pric) || 0;
  const prevLow = parseFloat(yesterday.low_pric) || 0;
  const prevVol = parseFloat(yesterday.trde_qty) || 0;
  const todayBody = Math.abs(todayClose - todayOpen);
  const upperTail = todayHigh - Math.max(todayClose, todayOpen);
  const upperTailRatio = todayBody > 0 ? upperTail / todayBody : 0;
  const prevBody = prevClose - prevOpen;
  const prevRange = prevHigh - prevLow;
  const prevIsLargeYangbong = prevBody > 0 && prevRange > 0 && (prevBody / prevRange) >= 0.6 && (prevClose - prevOpen) / prevOpen >= 0.03;
  const volDecreased = todayVol < prevVol * 0.7;
  if (upperTailRatio >= 0.5) return { label: '⚠️ 윗꼬리 과다', score: -3, pattern: 'bad_tail' };
  if (prevIsLargeYangbong && volDecreased) return { label: '⭐ K1패턴! 전일 장대양봉+오늘 단봉', score: 5, pattern: 'K1' };
  else if (prevIsLargeYangbong) return { label: '🔥 전일 장대양봉', score: 3, pattern: 'yangbong' };
  else if (volDecreased && todayClose > todayOpen) return { label: '📌 거래량 감소 양봉', score: 1, pattern: 'accumulate' };
  return { label: '', score: 0, pattern: 'none' };
}

function analyzeVolumeData(todayVol, prevVol) {
  if (!prevVol || prevVol === 0) return { label: '', score: 0 };
  const vsPrev = todayVol / prevVol;
  if (vsPrev >= 30) return { label: '💥💥 거래량 대폭발! 전일比 ' + vsPrev.toFixed(0) + '배', score: 5 };
  if (vsPrev >= 10) return { label: '💥 거래량 폭발 전일比 ' + vsPrev.toFixed(0) + '배', score: 3 };
  if (vsPrev >= 5) return { label: '🔥 거래량 급등 전일比 ' + vsPrev.toFixed(0) + '배', score: 2 };
  if (vsPrev >= 2) return { label: '📈 거래량 증가 전일比 ' + vsPrev.toFixed(1) + '배', score: 1 };
  return { label: '', score: 0 };
}

async function getNewsFromSource(url, titleRegex) {
  try {
    const html = await httpGet(url);
    const titles = [];
    let match;
    const regex = new RegExp(titleRegex, 'g');
    while ((match = regex.exec(html)) !== null && titles.length < 15) {
      const title = match[1].trim()
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/<[^>]+>/g, '').trim();
      if (title.length > 5) titles.push(title);
    }
    return titles;
  } catch(e) { return []; }
}

async function getAllNews() {
  const sources = await Promise.allSettled([
    getNewsFromSource('https://finance.naver.com/news/news_list.naver?mode=LSS2D&section_id=101&section_id2=258', 'class="[^"]*tit[^"]*"[^>]*>([^<]{5,50})<'),
    getNewsFromSource('https://www.hankyung.com/economy', '<h3[^>]*class="[^"]*tit[^"]*"[^>]*>\\s*<a[^>]*>([^<]{5,60})<'),
    getNewsFromSource('https://www.edaily.co.kr/news/newspath.asp?newsid=&MediaCodeNo=257', '<a[^>]*class="[^"]*news_tit[^"]*"[^>]*>([^<]{5,60})<'),
    getNewsFromSource('https://www.yna.co.kr/economy/all', '<strong[^>]*class="[^"]*tit[^"]*"[^>]*>([^<]{5,60})<'),
  ]);
  const allTitles = [];
  sources.forEach(r => { if (r.status === 'fulfilled') allTitles.push(...r.value); });
  return allTitles;
}

async function getUSMarket() {
  try {
    const html = await httpGet('https://finance.naver.com/world/');
    const result = {};
    const patterns = [
      { name: '나스닥', pattern: /나스닥[\s\S]{0,300}?([+-]\d+\.\d+)%/ },
      { name: '다우존스', pattern: /다우[\s\S]{0,300}?([+-]\d+\.\d+)%/ },
      { name: 'S&P500', pattern: /S&P[\s\S]{0,300}?([+-]\d+\.\d+)%/ },
    ];
    for (const { name, pattern } of patterns) {
      const match = html.match(pattern);
      if (match) result[name] = match[1] + '%';
    }
    return result;
  } catch(e) { return {}; }
}

function assessUSMarket(usMarket) {
  const nasdaq = parseFloat(usMarket['나스닥']) || 0;
  const dow = parseFloat(usMarket['다우존스']) || 0;
  if (nasdaq <= -2 || dow <= -2) return { risk: 'high', msg: '🚨 미국 시장 급락! 신중 또는 쉬는 날' };
  else if (nasdaq <= -1 || dow <= -1) return { risk: 'medium', msg: '⚠️ 미국 시장 하락 — 규모 축소 권장' };
  else if (nasdaq >= 1 || dow >= 1) return { risk: 'low', msg: '✅ 미국 시장 상승 — 유리한 환경' };
  return { risk: 'normal', msg: '📊 미국 시장 보합 — 종목 선별 신중히' };
}

function extractThemesFromNews(newsList) {
  const themeKeywords = {
    '반도체': ['반도체','HBM','AI칩','엔비디아','하이닉스','삼성전자','TSMC','DDR','메모리'],
    'AI/IT': ['AI','인공지능','로봇','자율주행','GPT','빅테크','클라우드','데이터센터'],
    '2차전지': ['배터리','2차전지','리튬','전기차','EV','양극재','음극재','전고체'],
    '바이오': ['바이오','신약','임상','제약','FDA','항암','치료제','백신'],
    '방산': ['방산','무기','군사','전쟁','우크라이나','방위','K방산','미사일'],
    '에너지': ['원전','원자력','수소','태양광','풍력','에너지','SMR'],
    '금융': ['금리','환율','달러','금융','은행','증권','기준금리','연준'],
    '조선': ['조선','선박','수주','LNG'],
  };
  const fullText = newsList.join(' ');
  const themeScores = {};
  for (const [theme, keywords] of Object.entries(themeKeywords)) {
    let score = 0;
    for (const kw of keywords) score += (fullText.match(new RegExp(kw, 'g')) || []).length;
    if (score > 0) themeScores[theme] = score;
  }
  return Object.entries(themeScores).sort((a,b) => b[1]-a[1]).slice(0,5).map(t => ({name:t[0],score:t[1]}));
}

function getTheme(name) {
  if (!name) return '기타';
  if (name.includes('증권')||name.includes('투자증권')) return '증권';
  if (name.includes('은행')||name.includes('금융')||name.includes('캐피탈')||name.includes('지주')) return '금융';
  if (name.includes('바이오')||name.includes('제약')||name.includes('헬스')||name.includes('의료')||name.includes('팜')||name.includes('메디')) return '바이오';
  if (name.includes('반도체')||name.includes('디스플레이')||name.includes('광학')) return '반도체';
  if (name.includes('2차전지')||name.includes('배터리')) return '2차전지';
  if (name.includes('AI')||name.includes('로봇')||name.includes('소프트')||name.includes('시스템')||name.includes('솔루션')||name.includes('데이터')) return 'AI/IT';
  if (name.includes('화학')||name.includes('소재')||name.includes('케미칼')) return '화학/소재';
  if (name.includes('건설')||name.includes('부동산')) return '건설';
  if (name.includes('방산')||name.includes('항공')||name.includes('우주')) return '방산';
  if (name.includes('해운')||name.includes('물류')||name.includes('운송')) return '물류';
  if (name.includes('조선')||name.includes('중공업')) return '조선';
  if (name.includes('게임')||name.includes('엔터')||name.includes('미디어')) return '엔터';
  return '기타';
}

async function sendTelegram(msg, chatId) {
  if (!BOT_TOKEN || !chatId) return;
  if (msg.length > 4000) msg = msg.substring(0, 4000) + '\n...(생략)';
  const body = JSON.stringify({ chat_id: chatId, text: msg });
  await rq({
    hostname: 'api.telegram.org', port: 443,
    path: '/bot' + BOT_TOKEN + '/sendMessage', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
}

async function sendAll(msg) {
  await sendTelegram(msg, CHAT_ID);
  if (CHANNEL_ID) await sendTelegram(msg, CHANNEL_ID);
}

function filterStocks(kospi, kosdaq) {
  const seen = new Set();
  return [...kospi, ...kosdaq].filter(s => {
    if (!s.cur_prc || !s.stk_nm) return false;
    if (seen.has(s.stk_nm)) return false;
    seen.add(s.stk_nm);
    const price = s.cur_prc.replace(/[^0-9\-]/g, '');
    if (price.startsWith('-')) return false;
    const name = s.stk_nm || '';
    if (name.includes('TIGER')||name.includes('KODEX')||name.includes('RISE')||
        name.includes('PLUS')||name.includes('ETF')||name.includes('ETN')||
        name.includes('선물')||name.includes('인버스')||name.includes('레버리지')) return false;
    return true;
  });
}

async function morningDantaScan() {
  console.log('아침 단타 스캔 시작...');
  try {
    const token = await getToken();
    const [news, usMarket, kospi, kosdaq] = await Promise.all([
      getAllNews(), getUSMarket(),
      getVolumeTop(token, '0'), getVolumeTop(token, '10')
    ]);
    const hotThemes = extractThemesFromNews(news);
    const hotThemeNames = hotThemes.map(t => t.name);
    const allStocks = filterStocks(kospi, kosdaq).filter(s => {
      const chgNum = parseFloat(s.flu_rt) || 0;
      return chgNum > 0 && chgNum < 25;
    });
    const top15 = allStocks.slice(0, 15);
    const candleDataList = [];
    for (const s of top15) {
      if (s.stk_cd) {
        const candles = await getDailyCandles(token, s.stk_cd);
        candleDataList.push(candles);
        await new Promise(r => setTimeout(r, 300));
      } else { candleDataList.push([]); }
    }
    const scored = top15.map((s, idx) => {
      const chgNum = parseFloat(s.flu_rt) || 0;
      const qty = parseFloat(s.trde_qty) || 0;
      const theme = getTheme(s.stk_nm);
      let score = 0;
      if (chgNum >= 3 && chgNum < 5) score += 2;
      if (chgNum >= 5 && chgNum < 10) score += 3;
      if (chgNum >= 10 && chgNum < 15) score += 2;
      if (chgNum >= 15 && chgNum < 20) score += 1;
      if (qty > 2000000) score += 3;
      else if (qty > 1000000) score += 2;
      else if (qty > 500000) score += 1;
      const themeObj = hotThemes.find(t => t.name === theme);
      if (themeObj) {
        if (themeObj.score >= 10) score += 3;
        else if (themeObj.score >= 5) score += 2;
        else score += 1;
      }
      const candles = candleDataList[idx];
      let volAnalysis = { label: '', score: 0 };
      let patternAnalysis = { label: '', score: 0, pattern: 'none' };
      if (candles.length >= 2) {
        const todayVol = parseFloat(candles[0].trde_qty) || 0;
        const prevVol = parseFloat(candles[1].trde_qty) || 0;
        volAnalysis = analyzeVolumeData(todayVol, prevVol);
        patternAnalysis = analyzeDailyPattern(candles);
        score += volAnalysis.score;
        score += patternAnalysis.score;
      }
      const curPrice = parseFloat((s.cur_prc || '').replace(/[^0-9]/g, '')) || 0;
      const entryPrice = Math.round(curPrice * 0.97);
      const stopLoss = Math.round(entryPrice * 0.99);
      const target = Math.round(entryPrice * 1.05);
      const danger = chgNum >= 15;
      return { ...s, chgNum, qty, theme, score, curPrice, entryPrice, stopLoss, target, danger, volAnalysis, patternAnalysis };
    }).filter(s => s.patternAnalysis.pattern !== 'bad_tail').sort((a,b) => b.score-a.score);
    const danta = scored.filter(s => !s.danger).slice(0, 7);
    const danger = scored.filter(s => s.danger).slice(0, 3);
    const nowStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    let msg = '━━━━━━━━━━━━━━━━\n🔥 아침 단타 스캐너\n⏰ ' + nowStr + '\n━━━━━━━━━━━━━━━━\n\n';
    msg += '🌏 간밤 미국 시장\n';
    if (Object.keys(usMarket).length > 0) {
      for (const [k, v] of Object.entries(usMarket)) msg += (v.startsWith('+') ? '📈' : '📉') + ' ' + k + ': ' + v + '\n';
      msg += assessUSMarket(usMarket).msg + '\n';
    } else { msg += '데이터 수집 중\n'; }
    msg += '\n🎯 오늘 핫 테마\n';
    hotThemes.slice(0,3).forEach((t,i) => { msg += (i+1) + '위. ' + t.name + ' (언급 ' + t.score + '회)\n'; });
    msg += '\n';
    if (news.length > 0) {
      msg += '📰 주요 뉴스\n';
      news.slice(0,3).forEach(n => { msg += '• ' + n.substring(0,28) + '\n'; });
      msg += '\n';
    }
    msg += '⚡ 단타 후보 TOP 7\n─────────────────\n';
    danta.forEach((s,i) => {
      const star = s.score >= 10 ? '⭐⭐⭐' : s.score >= 7 ? '⭐⭐' : '⭐';
      const hotTag = hotThemeNames.includes(s.theme) ? ' 🔥핫테마' : '';
      msg += star + ' ' + (i+1) + '위. [' + s.theme + '] ' + s.stk_nm + hotTag + '\n';
      msg += '   현재가: ' + s.curPrice.toLocaleString() + '원 | 등락: +' + s.flu_rt + '%\n';
      msg += '   거래량: ' + Number(s.trde_qty).toLocaleString() + '\n';
      if (s.volAnalysis.label) msg += '   📊 ' + s.volAnalysis.label + '\n';
      if (s.patternAnalysis.label) msg += '   📈 ' + s.patternAnalysis.label + '\n';
      msg += '   ⏳진입가: ' + s.entryPrice.toLocaleString() + '원 (-3%)\n';
      msg += '   🛑손절가: ' + s.stopLoss.toLocaleString() + '원 (-1%)\n';
      msg += '   🎯목표가: ' + s.target.toLocaleString() + '원 (+5%)\n\n';
    });
    if (danger.length > 0) {
      msg += '🚨 추격 절대 금지\n';
      danger.forEach(s => { msg += '⛔ ' + s.stk_nm + ' | +' + s.flu_rt + '%\n'; });
      msg += '\n';
    }
    msg += '━━━━━━━━━━━━━━━━\n✅ 대기진입가 지정가 주문 후 대기\n⛔ 추격매수 절대 금지\n⛔ 10시 이후 신규 진입 금지\n⛔ 하루 1종목만\n⛔ 손절 후 재진입 금지';
    console.log(msg);
    await sendAll(msg);
    console.log('전송완료!');
  } catch(e) { console.log('에러:', e.message); }
}

async function closingRun() {
  console.log('종가매매 스캔 시작...');
  try {
    const token = await getToken();
    const [news, usMarket, kospi, kosdaq] = await Promise.all([
      getAllNews(), getUSMarket(),
      getVolumeTop(token, '0'), getVolumeTop(token, '10')
    ]);
    const usRisk = assessUSMarket(usMarket);
    const hotThemes = extractThemesFromNews(news);
    const hotThemeNames = hotThemes.map(t => t.name);
    const allStocks = filterStocks(kospi, kosdaq).filter(s => {
      const chgNum = parseFloat(s.flu_rt) || 0;
      const qty = parseFloat(s.trde_qty) || 0;
      return chgNum >= 3 && chgNum < 15 && qty >= 300000;
    });
    const top10 = allStocks.slice(0, 10);
    const candleDataList = [];
    for (const s of top10) {
      if (s.stk_cd) {
        const candles = await getDailyCandles(token, s.stk_cd);
        candleDataList.push(candles);
        await new Promise(r => setTimeout(r, 300));
      } else { candleDataList.push([]); }
    }
    const scored = top10.map((s, idx) => {
      const chgNum = parseFloat(s.flu_rt) || 0;
      const qty = parseFloat(s.trde_qty) || 0;
      const theme = getTheme(s.stk_nm);
      let score = 0;
      if (chgNum >= 5 && chgNum < 10) score += 3;
      else if (chgNum >= 3 && chgNum < 5) score += 2;
      else if (chgNum >= 10 && chgNum < 15) score += 1;
      if (qty > 2000000) score += 3;
      else if (qty > 1000000) score += 2;
      else if (qty > 500000) score += 1;
      const themeObj = hotThemes.find(t => t.name === theme);
      if (themeObj) {
        if (themeObj.score >= 10) score += 3;
        else if (themeObj.score >= 5) score += 2;
        else score += 1;
      }
      const candles = candleDataList[idx];
      let volAnalysis = { label: '', score: 0 };
      let patternAnalysis = { label: '', score: 0, pattern: 'none' };
      if (candles.length >= 2) {
        const todayVol = parseFloat(candles[0].trde_qty) || 0;
        const prevVol = parseFloat(candles[1].trde_qty) || 0;
        volAnalysis = analyzeVolumeData(todayVol, prevVol);
        patternAnalysis = analyzeDailyPattern(candles);
        score += volAnalysis.score;
        score += patternAnalysis.score;
      }
      const curPrice = parseFloat((s.cur_prc || '').replace(/[^0-9]/g, '')) || 0;
      const stopLoss = Math.round(curPrice * 0.94);
      const target = Math.round(curPrice * 1.05);
      const gapStopLoss = Math.round(curPrice * 0.97);
      return { ...s, chgNum, qty, theme, score, curPrice, stopLoss, target, gapStopLoss, volAnalysis, patternAnalysis };
    }).filter(s => s.patternAnalysis.pattern !== 'bad_tail').sort((a,b) => b.score-a.score).slice(0,7);
    const nowStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    let msg = '━━━━━━━━━━━━━━━━\n🌙 종가매매 후보\n⏰ ' + nowStr + '\n━━━━━━━━━━━━━━━━\n\n';
    msg += '🌏 미국 시장\n';
    if (Object.keys(usMarket).length > 0) {
      for (const [k, v] of Object.entries(usMarket)) msg += (v.startsWith('+') ? '📈' : '📉') + ' ' + k + ': ' + v + '\n';
    }
    msg += usRisk.msg + '\n\n';
    msg += '🎯 핫 테마\n';
    hotThemes.slice(0,3).forEach((t,i) => { msg += (i+1) + '위. ' + t.name + ' (언급 ' + t.score + '회)\n'; });
    msg += '\n';
    if (news.length > 0) {
      msg += '📰 주요 뉴스\n';
      news.slice(0,3).forEach(n => { msg += '• ' + n.substring(0,28) + '\n'; });
      msg += '\n';
    }
    msg += '📌 진입: 14:50~15:00 종가 매수\n📌 매도: 내일 9:00~9:05 전량\n📌 손절: -6%\n─────────────────\n';
    scored.forEach((s,i) => {
      const stars = s.score >= 10 ? '⭐⭐⭐' : s.score >= 7 ? '⭐⭐' : '⭐';
      const hotTag = hotThemeNames.includes(s.theme) ? ' 🔥핫테마' : '';
      msg += stars + ' ' + (i+1) + '위. [' + s.theme + '] ' + s.stk_nm + hotTag + '\n';
      msg += '   현재가: ' + s.curPrice.toLocaleString() + '원 | 등락: +' + s.flu_rt + '%\n';
      msg += '   거래량: ' + Number(s.trde_qty).toLocaleString() + '\n';
      if (s.volAnalysis.label) msg += '   📊 ' + s.volAnalysis.label + '\n';
      if (s.patternAnalysis.label) msg += '   📈 ' + s.patternAnalysis.label + '\n';
      msg += '   🛑손절가: ' + s.stopLoss.toLocaleString() + '원 (-6%)\n';
      msg += '   ⚡갭손절: ' + s.gapStopLoss.toLocaleString() + '원 (시초가 -3% 이하시)\n';
      msg += '   🎯목표: ' + s.target.toLocaleString() + '원 (+5%)\n\n';
    });
    msg += '━━━━━━━━━━━━━━━━\n✅ K1패턴+핫테마 최우선\n⛔ 미국 급락일 매매 금지\n⛔ 하루 1종목만\n⛔ 손절 후 재진입 금지';
    console.log(msg);
    await sendAll(msg);
    console.log('종가매매 전송완료!');
  } catch(e) { console.log('에러:', e.message); }
}

// 시간에 따라 함수 선택
if (hour >= 6 && hour <= 9) {
  morningDantaScan();
} else if (hour >= 14 && hour <= 15) {
  closingRun();
} else {
  morningDantaScan(); // 기본값
}