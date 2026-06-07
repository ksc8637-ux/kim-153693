
const fs = require('fs');
const https = require('https');
const http = require('http');
const cron = require('node-cron');

const ak = fs.readFileSync('50446028_appkey.txt', 'utf8').trim();
const sk = fs.readFileSync('50446028_secretkey.txt', 'utf8').trim();
const BOT_TOKEN = fs.existsSync('telegram_token.txt') ? fs.readFileSync('telegram_token.txt', 'utf8').trim() : '';
const CHAT_ID = fs.existsSync('telegram_chatid.txt') ? fs.readFileSync('telegram_chatid.txt', 'utf8').trim() : '';
const CHANNEL_ID = fs.existsSync('telegram_channel.txt') ? fs.readFileSync('telegram_channel.txt', 'utf8').trim() : '';

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
  if (upperTailRatio >= 0.5) {
    return { label: '⚠️ 윗꼬리 과다 — 세력 매도 의심', score: -3, pattern: 'bad_tail' };
  }
  if (prevIsLargeYangbong && volDecreased) {
    return { label: '⭐ K1패턴! 전일 장대양봉+오늘 단봉 — 최우선', score: 5, pattern: 'K1' };
  } else if (prevIsLargeYangbong) {
    return { label: '🔥 전일 장대양봉 — 종가매매 후보', score: 3, pattern: 'yangbong' };
  } else if (volDecreased && todayClose > todayOpen) {
    return { label: '📌 거래량 감소 양봉 — 매집 가능성', score: 1, pattern: 'accumulate' };
  }
  return { label: '', score: 0, pattern: 'none' };
}

function analyzeVolumeData(todayVol, prevVol) {
  if (!prevVol || prevVol === 0) return { label: '', score: 0, explosion: false };
  const vsPrev = todayVol / prevVol;
  if (vsPrev >= 30) return { label: '💥💥 거래량 대폭발! 전일比 ' + vsPrev.toFixed(0) + '배 ✨세력진입의심', score: 5, explosion: true };
  if (vsPrev >= 10) return { label: '💥 거래량 폭발 전일比 ' + vsPrev.toFixed(0) + '배 ✨세력진입의심', score: 3, explosion: true };
  if (vsPrev >= 5) return { label: '🔥 거래량 급등 전일比 ' + vsPrev.toFixed(0) + '배', score: 2, explosion: false };
  if (vsPrev >= 2) return { label: '📈 거래량 증가 전일比 ' + vsPrev.toFixed(1) + '배', score: 1, explosion: false };
  return { label: '', score: 0, explosion: false };
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
  sources.forEach(result => {
    if (result.status === 'fulfilled') allTitles.push(...result.value);
  });
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

// 미국 시장 위험 판단
function assessUSMarket(usMarket) {
  const nasdaq = parseFloat(usMarket['나스닥']) || 0;
  const dow = parseFloat(usMarket['다우존스']) || 0;
  if (nasdaq <= -2 || dow <= -2) {
    return { risk: 'high', msg: '🚨 미국 시장 급락! 종가매매 매우 위험 — 신중 또는 쉬는 날' };
  } else if (nasdaq <= -1 || dow <= -1) {
    return { risk: 'medium', msg: '⚠️ 미국 시장 하락 — 종가매매 규모 축소 권장' };
  } else if (nasdaq >= 1 || dow >= 1) {
    return { risk: 'low', msg: '✅ 미국 시장 상승 — 종가매매 유리한 환경' };
  }
  return { risk: 'normal', msg: '📊 미국 시장 보합 — 종목 선별 신중히' };
}

function extractThemesFromNews(newsList) {
  const themeKeywords = {
    '반도체': ['반도체', 'HBM', 'AI칩', '엔비디아', '하이닉스', '삼성전자', 'TSMC', 'DDR', '메모리'],
    'AI/IT': ['AI', '인공지능', '로봇', '자율주행', 'GPT', '빅테크', '클라우드', '데이터센터'],
    '2차전지': ['배터리', '2차전지', '리튬', '전기차', 'EV', '양극재', '음극재', '전고체'],
    '바이오': ['바이오', '신약', '임상', '제약', 'FDA', '항암', '치료제', '백신'],
    '방산': ['방산', '무기', '군사', '전쟁', '우크라이나', '방위', 'K방산', '미사일'],
    '에너지': ['원전', '원자력', '수소', '태양광', '풍력', '에너지', 'SMR'],
    '금융': ['금리', '환율', '달러', '금융', '은행', '증권', '기준금리', '연준'],
    '건설/부동산': ['부동산', '아파트', '건설', '분양', '재건축', '재개발', 'PF'],
    '해운/물류': ['해운', '물류', '항만', '컨테이너', '운임', 'HMM'],
    '엔터': ['엔터', 'K팝', '드라마', '영화', '콘텐츠', 'OTT'],
    '조선': ['조선', '선박', '수주', 'LNG', '액화천연가스'],
  };
  const fullText = newsList.join(' ');
  const themeScores = {};
  for (const [theme, keywords] of Object.entries(themeKeywords)) {
    let score = 0;
    for (const kw of keywords) {
      score += (fullText.match(new RegExp(kw, 'g')) || []).length;
    }
    if (score > 0) themeScores[theme] = score;
  }
  return Object.entries(themeScores).sort((a, b) => b[1] - a[1]).slice(0, 5).map(t => ({ name: t[0], score: t[1] }));
}

function getTheme(name) {
  if (!name) return '기타';
  if (name.includes('증권') || name.includes('투자증권')) return '증권';
  if (name.includes('은행') || name.includes('금융') || name.includes('캐피탈') || name.includes('지주')) return '금융';
  if (name.includes('보험') || name.includes('화재') || name.includes('생명')) return '보험';
  if (name.includes('바이오') || name.includes('제약') || name.includes('헬스') || name.includes('의료') || name.includes('팜') || name.includes('메디') || name.includes('진단')) return '바이오';
  if (name.includes('반도체') || name.includes('HPSP') || name.includes('디스플레이') || name.includes('광학') || name.includes('레이저')) return '반도체';
  if (name.includes('전자') || name.includes('일렉') || name.includes('KEC') || name.includes('에이치엠')) return '전자부품';
  if (name.includes('2차전지') || name.includes('배터리') || name.includes('이차전지')) return '2차전지';
  if (name.includes('AI') || name.includes('로봇') || name.includes('소프트') || name.includes('시스템') || name.includes('솔루션') || name.includes('나무') || name.includes('데이터')) return 'AI/IT';
  if (name.includes('화학') || name.includes('소재') || name.includes('케미칼') || name.includes('한켐') || name.includes('알트')) return '화학/소재';
  if (name.includes('건설') || name.includes('부동산') || name.includes('리츠')) return '건설';
  if (name.includes('방산') || name.includes('항공') || name.includes('우주') || name.includes('방위')) return '방산';
  if (name.includes('해운') || name.includes('물류') || name.includes('운송') || name.includes('택배')) return '물류';
  if (name.includes('조선') || name.includes('중공업')) return '조선';
  if (name.includes('게임') || name.includes('엔터') || name.includes('미디어') || name.includes('콘텐츠')) return '엔터';
  if (name.includes('통신') || name.includes('텔레콤')) return '통신';
  if (name.includes('콤') || name.includes('네트워크') || name.includes('안테나') || name.includes('무선')) return '통신장비';
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
    if (name.includes('TIGER') || name.includes('KODEX') || name.includes('RISE') ||
        name.includes('PLUS') || name.includes('ETF') || name.includes('ETN') ||
        name.includes('선물') || name.includes('인버스') || name.includes('레버리지')) return false;
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
    }).sort((a, b) => b.score - a.score);
    const danta = scored.filter(s => !s.danger && s.patternAnalysis.pattern !== 'bad_tail').slice(0, 7);
    const danger = scored.filter(s => s.danger).slice(0, 3);
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    let msg = '━━━━━━━━━━━━━━━━\n';
    msg += '🔥 아침 단타 스캐너\n';
    msg += '⏰ ' + now + '\n';
    msg += '━━━━━━━━━━━━━━━━\n\n';
    msg += '🌏 간밤 미국 시장\n';
    if (Object.keys(usMarket).length > 0) {
      for (const [k, v] of Object.entries(usMarket)) {
        msg += (v.startsWith('+') ? '📈' : '📉') + ' ' + k + ': ' + v + '\n';
      }
      const usRisk = assessUSMarket(usMarket);
      msg += usRisk.msg + '\n';
    } else { msg += '데이터 수집 중\n'; }
    msg += '\n';
    msg += '🎯 오늘 핫 테마 (4개 뉴스 합산)\n';
    hotThemes.slice(0, 3).forEach((t, i) => {
      msg += (i+1) + '위. ' + t.name + ' (언급 ' + t.score + '회)\n';
    });
    msg += '\n';
    if (news.length > 0) {
      msg += '📰 주요 뉴스\n';
      news.slice(0, 3).forEach(n => { msg += '• ' + n.substring(0, 28) + '\n'; });
      msg += '\n';
    }
    msg += '⚡ 단타 후보 TOP 7\n';
    msg += '─────────────────\n';
    danta.forEach((s, i) => {
      const star = s.score >= 10 ? '⭐⭐⭐' : s.score >= 7 ? '⭐⭐' : '⭐';
      const hotTag = hotThemeNames.includes(s.theme) ? ' 🔥핫테마' : '';
      msg += star + ' ' + (i+1) + '위. [' + s.theme + '] ' + s.stk_nm + hotTag + '\n';
      msg += '   현재가: ' + s.curPrice.toLocaleString() + '원 | 등락: +' + s.flu_rt + '%\n';
      msg += '   거래량: ' + Number(s.trde_qty).toLocaleString() + '\n';
      if (s.volAnalysis.label) msg += '   📊 ' + s.volAnalysis.label + '\n';
      if (s.patternAnalysis.label) msg += '   📈 ' + s.patternAnalysis.label + '\n';
      msg += '   ⏳대기진입가: ' + s.entryPrice.toLocaleString() + '원 (현재가 -3%)\n';
      msg += '   🛑손절가: ' + s.stopLoss.toLocaleString() + '원 (진입가 -1%)\n';
      msg += '   🎯목표가: ' + s.target.toLocaleString() + '원 (진입가 +5%)\n\n';
    });
    if (danger.length > 0) {
      msg += '🚨 추격 절대 금지\n';
      danger.forEach(s => { msg += '⛔ ' + s.stk_nm + ' | +' + s.flu_rt + '%\n'; });
      msg += '\n';
    }
    msg += '━━━━━━━━━━━━━━━━\n';
    msg += '📌 진입 원칙\n';
    msg += '✅ 대기진입가에 지정가 주문 걸고 대기\n';
    msg += '✅ 체결 즉시 올라야 정상\n';
    msg += '⛔ 현재가 추격매수 절대 금지\n';
    msg += '⛔ 안 잡히면 그 종목 포기 — 미련 금지\n';
    msg += '⛔ 10시 이후 신규 진입 금지\n\n';
    msg += '🛑 손절 원칙\n';
    msg += '✅ 진입 즉시 0624 손절가 등록 필수\n';
    msg += '✅ 체결 후 -1% 하락시 즉시 시장가 손절\n';
    msg += '✅ 손절 후 재진입 절대 금지\n';
    msg += '✅ 손절가 해제 절대 금지\n\n';
    msg += '🎯 오늘의 매매 규칙\n';
    msg += '✅ 하루 1번 1종목만\n';
    msg += '✅ 수익나도 끝 — 손절나도 끝\n';
    msg += '⛔ 2번째 매매 절대 금지\n';
    msg += '⛔ 손절 후 만회매매 절대 금지\n\n';
    msg += '🔴 철칙\n';
    msg += '⚠️ 미수 절대 금지\n';
    msg += '⚠️ 오늘 못 잡으면 내일 또 온다';
    console.log(msg);
    await sendAll(msg);
    console.log('단타 전송완료!');
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

    // 미국 시장 위험 판단
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
      let score = 0;
      if (chgNum >= 5 && chgNum < 10) score += 3;
      else if (chgNum >= 3 && chgNum < 5) score += 2;
      else if (chgNum >= 10 && chgNum < 15) score += 1;
      if (qty > 2000000) score += 3;
      else if (qty > 1000000) score += 2;
      else if (qty > 500000) score += 1;

      const theme = getTheme(s.stk_nm);

      // 핫테마 보너스 — 종가매매에도 적용
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
      // 갭하락 손절 기준 — 시초가가 매수가 -3% 이하면 즉시 손절
      const gapStopLoss = Math.round(curPrice * 0.97);
      return { ...s, chgNum, qty, theme, score, curPrice, stopLoss, target, gapStopLoss, volAnalysis, patternAnalysis };
    })
    .filter(s => s.patternAnalysis.pattern !== 'bad_tail')
    .sort((a, b) => b.score - a.score)
    .slice(0, 7);

    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    let msg = '━━━━━━━━━━━━━━━━\n';
    msg += '🌙 종가매매 후보\n';
    msg += '⏰ ' + now + '\n';
    msg += '━━━━━━━━━━━━━━━━\n\n';

    // 미국 시장 상황
    msg += '🌏 미국 시장 현황\n';
    if (Object.keys(usMarket).length > 0) {
      for (const [k, v] of Object.entries(usMarket)) {
        msg += (v.startsWith('+') ? '📈' : '📉') + ' ' + k + ': ' + v + '\n';
      }
    }
    msg += usRisk.msg + '\n\n';

    // 오늘 핫테마
    msg += '🎯 오늘 핫 테마 (종가매매 우선순위)\n';
    hotThemes.slice(0, 3).forEach((t, i) => {
      msg += (i+1) + '위. ' + t.name + ' (언급 ' + t.score + '회)\n';
    });
    msg += '\n';

    // 주요 뉴스
    if (news.length > 0) {
      msg += '📰 오늘 주요 뉴스\n';
      news.slice(0, 3).forEach(n => { msg += '• ' + n.substring(0, 28) + '\n'; });
      msg += '\n';
    }

    msg += '📌 진입: 14:50~15:00 종가 매수\n';
    msg += '📌 매도: 내일 9:00~9:05 시초가 전량\n';
    msg += '📌 손절: -6% (0624 필수 등록)\n\n';
    msg += '─────────────────\n';

    scored.forEach((s, i) => {
      const stars = s.score >= 10 ? '⭐⭐⭐' : s.score >= 7 ? '⭐⭐' : '⭐';
      const hotTag = hotThemeNames.includes(s.theme) ? ' 🔥핫테마' : '';
      msg += stars + ' ' + (i+1) + '위. [' + s.theme + '] ' + s.stk_nm + hotTag + '\n';
      msg += '   현재가: ' + s.curPrice.toLocaleString() + '원 | 등락: +' + s.flu_rt + '%\n';
      msg += '   거래량: ' + Number(s.trde_qty).toLocaleString() + '\n';
      if (s.volAnalysis.label) msg += '   📊 ' + s.volAnalysis.label + '\n';
      if (s.patternAnalysis.label) msg += '   📈 ' + s.patternAnalysis.label + '\n';
      msg += '   ✅진입가: ' + s.curPrice.toLocaleString() + '원 (종가 매수)\n';
      msg += '   🛑손절가: ' + s.stopLoss.toLocaleString() + '원 (-6%)\n';
      msg += '   ⚡갭하락손절: ' + s.gapStopLoss.toLocaleString() + '원 (시초가 -3% 이하시 즉시)\n';
      msg += '   🎯내일목표: ' + s.target.toLocaleString() + '원 (+5%)\n\n';
    });

    msg += '━━━━━━━━━━━━━━━━\n';
    msg += '📌 진입 원칙\n';
    msg += '✅ K1패턴⭐⭐⭐ + 🔥핫테마 종목 최우선\n';
    msg += '✅ 윗꼬리 긴 종목 자동 제외됨\n';
    msg += '✅ 미국 시장 급락일 매매 쉬어라\n';
    msg += '✅ 하루 1종목만\n\n';
    msg += '🛑 손절 원칙\n';
    msg += '✅ 매수 즉시 0624 손절가 등록\n';
    msg += '✅ 손절가 절대 해제 금지\n';
    msg += '✅ 손절 터지면 재진입 금지\n\n';
    msg += '🎯 내일 매도 원칙\n';
    msg += '✅ 내일 9:00~9:05 시초가 전량 매도\n';
    msg += '✅ 갭상승 추가 수익 욕심내지 마라\n';
    msg += '✅ 갭하락 시초가가 손절가 이하면 즉시 시장가 매도\n\n';
    msg += '🔴 철칙\n';
    msg += '⚠️ 미수 절대 금지\n';
    msg += '⚠️ 오늘 못 잡으면 내일 또 온다';

    console.log(msg);
    await sendAll(msg);
    console.log('종가매매 전송완료!');
  } catch(e) { console.log('에러:', e.message); }
}

cron.schedule('40 7 * * 1-5', morningDantaScan, { timezone: 'Asia/Seoul' });
cron.schedule('50 8 * * 1-5', morningDantaScan, { timezone: 'Asia/Seoul' });
cron.schedule('30 14 * * 1-5', closingRun, { timezone: 'Asia/Seoul' });
cron.schedule('50 14 * * 1-5', closingRun, { timezone: 'Asia/Seoul' });

console.log('✅ 주식비서 완전체 가동!');
console.log('📊 7:40 단타 / 8:50 단타 / 14:30 종가매매 / 14:50 종가매매 최종');
console.log('📢 개인 + 대장주 알림방 채널 동시 전송');
morningDantaScan();