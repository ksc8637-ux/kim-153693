// ============================================================
// 종가매매 기계 v3 — 검증된 daiangju 방식 기반, 열쇠는 깃허브 금고 사용
// ============================================================
const APPKEY = process.env.APPKEY;
const SECRETKEY = process.env.SECRETKEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const RULE = {
  MIN_TRDE_AMT: 50000000000, // ① 거래대금 500억 (원)
  MIN_RATE: 3,               // ② 등락률 +3% 이상
  MAX_RATE: 25,              // ② +25% 이하
  MAX_UPPER_TAIL: 0.25,      // ③ 윗꼬리 25% 이하
  MIN_CLOSE_POS: 0.70,       // ④ 종가 고가권
  MAX_GAP_TO_HIGH: 0.10,     // ⑤ 전고점 이격 10%
  VOL_MULT: 3,               // ⑦ 거래량 3배
  SCAN_TOP_N: 30,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => Math.abs(parseFloat(String(v ?? "0").replace(/[+,]/g, ""))) || 0;
const signedNum = (v) => parseFloat(String(v ?? "0").replace(/[,]/g, "")) || 0;

function todayKST() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function fetchRetry(url, options, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, options);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.log(`통신 실패 ${i}/${tries}: ${e.message}`);
      if (i < tries) await sleep(3000 * i);
    }
  }
  throw lastErr;
}

let accessToken = null;
async function getAccessToken() {
  const data = await fetchRetry("https://api.kiwoom.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: APPKEY, secretkey: SECRETKEY }),
  });
  accessToken = data.token;
  if (!accessToken) throw new Error("토큰 발급 실패: " + JSON.stringify(data).slice(0, 200));
}

async function sendTelegram(message) {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: "HTML" }),
      });
      if (res.ok) return true;
    } catch (e) {
      console.log(`텔레그램 실패 ${i}/3: ${e.message}`);
    }
    await sleep(3000);
  }
  return false;
}

// 거래량/등락 순위 — daiangju에서 작동 검증된 호출 그대로
async function getRanking() {
  const data = await fetchRetry("https://api.kiwoom.com/api/dostk/rkinfo", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, "api-id": "ka90003" },
    body: JSON.stringify({ mrkt_tp: "0", sort_tp: "1", stk_cnd: "0", trde_qty_tp: "0", pri_range_strt: "0", pri_range_end: "0", trde_prica_range_strt: "0", trde_prica_range_end: "0" }),
  });
  const list = data?.output || [];
  if (list.length === 0) throw new Error("순위 데이터 없음: " + JSON.stringify(data).slice(0, 200));
  return list.slice(0, RULE.SCAN_TOP_N);
}

// 일봉 차트
async function getDailyChart(stkCd) {
  const data = await fetchRetry("https://api.kiwoom.com/api/dostk/chart", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, "api-id": "ka10081" },
    body: JSON.stringify({ stk_cd: stkCd, base_dt: todayKST(), upd_stkpc_tp: "1" }),
  });
  const listKey = Object.keys(data || {}).find((k) => Array.isArray(data[k]) && data[k].length > 0);
  if (!listKey) return null;
  return data[listKey].map((r) => ({
    date: r.dt || r.date,
    open: num(r.open_pric ?? r.opn_prc ?? r.open),
    high: num(r.high_pric ?? r.hg_prc ?? r.high),
    low: num(r.low_pric ?? r.lw_prc ?? r.low),
    close: num(r.cur_prc ?? r.clos_prc ?? r.close),
    vol: num(r.trde_qty ?? r.vol),
  }));
}

function scoreStock(row, chart) {
  const name = row.stk_nm || row.stk_cd;
  const price = num(row.cur_prc);
  const rate = signedNum(row.flu_rt);
  const vol = num(row.trde_qty);
  const result = { name, code: row.stk_cd, score: 0, fail: [], rate, price, freshDate: null };

  if (!chart || chart.length < 65) { result.fail.push("데이터부족"); return result; }

  const today = chart[0];
  result.freshDate = today.date;
  const past60 = chart.slice(1, 61);
  const past20 = chart.slice(1, 21);

  const trdeAmt = price * vol; // 거래대금 추정 (원)
  const range = today.high - today.low;
  const upperTail = range > 0 ? (today.high - today.close) / range : 1;
  const closePos = range > 0 ? (today.close - today.low) / range : 0;
  const high60 = Math.max(...past60.map((d) => d.high));
  const box20 = Math.max(...past20.map((d) => d.high));
  const avgVol20 = past20.reduce((s, d) => s + d.vol, 0) / past20.length;

  const checks = [
    ["①거래대금", trdeAmt >= RULE.MIN_TRDE_AMT],
    ["②등락률", rate >= RULE.MIN_RATE && rate <= RULE.MAX_RATE],
    ["③윗꼬리", today.close > today.open && upperTail <= RULE.MAX_UPPER_TAIL],
    ["④고가권", closePos >= RULE.MIN_CLOSE_POS],
    ["⑤전고점", today.close >= high60 * (1 - RULE.MAX_GAP_TO_HIGH)],
    ["⑥박스돌파", today.close > box20],
    ["⑦거래량", avgVol20 > 0 && today.vol >= avgVol20 * RULE.VOL_MULT],
  ];
  for (const [label, ok] of checks) {
    if (ok) result.score++;
    else result.fail.push(label);
  }
  result.trdeAmtEok = Math.round(trdeAmt / 100000000); // 억 단위
  return result;
}

async function main() {
  console.log("=== 종가매매 기계 v3 시작 ===", todayKST());
  await getAccessToken();
  console.log("토큰 발급 완료");

  const top = await getRanking();
  console.log(`상위 ${top.length}종목 검사`);

  const results = [];
  let errCount = 0;
  for (const row of top) {
    try {
      const chart = await getDailyChart(row.stk_cd);
      const r = scoreStock(row, chart);
      results.push(r);
      console.log(`${r.name} → ${r.score}/7 (미충족: ${r.fail.join(",")})`);
    } catch (e) {
      errCount++;
      console.log(`${row.stk_nm || row.stk_cd} 오류(건너뜀): ${e.message}`);
    }
    await sleep(300);
  }
  if (results.length === 0) throw new Error("전 종목 분석 실패");

  const fresh = results.filter((r) => r.freshDate === todayKST());
  if (fresh.length < results.length * 0.3) {
    await sendTelegram(`📊 종가매매 기계 (${todayKST()})\n휴장일이거나 데이터 미갱신. 오늘 매매 없음.`);
    return;
  }

  const green = results.filter((r) => r.score >= 6);
  const yellow = results.filter((r) => r.score === 5);

  let msg = `📊 <b>종가매매 후보 (${todayKST()})</b>\n검사 ${results.length}종목 (오류 ${errCount}건)\n\n`;
  if (green.length === 0 && yellow.length === 0) {
    msg += `🔴 <b>조건 충족 없음 → 오늘 매매 금지</b>\n안 하는 것도 매매다.`;
  } else {
    for (const r of green) msg += `🟢 <b>${r.name}</b> (${r.code}) ${r.score}/7 | +${r.rate}% | ${r.trdeAmtEok}억\n   미충족: ${r.fail.join(",") || "없음"}\n`;
    for (const r of yellow) msg += `🟡 ${r.name} (${r.code}) 5/7 | +${r.rate}% | 미충족: ${r.fail.join(",")}\n`;
    msg += `\n✅ 직접확인: ①재료 내일도 가나? ②테마 1등인가?\n⏰ 매수 15:15~15:20 | 하루 1종목\n🚫 미수·몰빵·물타기·추격 금지 | 자동손절 -3.1%`;
  }

  const sent = await sendTelegram(msg);
  if (!sent) throw new Error("텔레그램 발송 실패");
  console.log("=== 보고 완료 ===");
}

main().catch(async (e) => {
  console.error("실행 오류:", e);
  await sendTelegram(`⚠️ 종가매매 기계 오류: ${e.message}`).catch(() => {});
  process.exit(1);
});
