// ============================================================
// 종가매매 기계 v2.0 (jongga_actions.cjs) — 멈추지 않는 판
// 실행: 깃허브 액션 (평일 15:00 한국시간, 컴퓨터 꺼도 작동)
// ============================================================

// ─── 설정 (daiangju_actions.cjs에서 그대로 복사) ───────────
const APP_KEY = "여기에_앱키";
const SECRET_KEY = "여기에_시크릿키";
const TELEGRAM_TOKEN = "여기에_텔레그램토큰";
const CHAT_ID = "여기에_개인챗ID";

const API_BASE = "https://api.kiwoom.com";

// ─── 7조건 기준값 ───────────────────────────────────────────
const RULE = {
  MIN_TRDE_AMT: 50000,
  MIN_RATE: 3,
  MAX_RATE: 25,
  MAX_UPPER_TAIL: 0.25,
  MIN_CLOSE_POS: 0.70,
  MAX_GAP_TO_HIGH: 0.10,
  BOX_DAYS: 20,
  VOL_MULT: 3,
  SCAN_TOP_N: 30,
};

// ============================================================
// 공통: 재시도 내장 통신 (3회까지 자동 재시도)
// ============================================================
async function fetchRetry(url, options, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.log(`통신 실패 ${i}/${tries}회: ${e.message} → ${i < tries ? "재시도" : "포기"}`);
      if (i < tries) await sleep(3000 * i);
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken() {
  const data = await fetchRetry(`${API_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: APP_KEY, secretkey: SECRET_KEY }),
  });
  if (!data.token) throw new Error("토큰 발급 실패: " + JSON.stringify(data).slice(0, 200));
  return data.token;
}

async function callTR(token, path, apiId, body) {
  return fetchRetry(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      authorization: `Bearer ${token}`,
      "api-id": apiId,
    },
    body: JSON.stringify(body),
  });
}

async function sendTelegram(text) {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return true;
    } catch (e) {
      console.log(`텔레그램 실패 ${i}/3: ${e.message}`);
    }
    await sleep(3000);
  }
  return false;
}

const num = (v) => Math.abs(parseFloat(String(v ?? "0").replace(/[+,]/g, ""))) || 0;
const signedNum = (v) => parseFloat(String(v ?? "0").replace(/[,]/g, "")) || 0;

function todayKST() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ============================================================
// 1단계: 거래대금 상위 (ka10032)
// ============================================================
async function getTopByTradeAmount(token) {
  const data = await callTR(token, "/api/dostk/rkinfo", "ka10032", {
    mrkt_tp: "000",
    mang_stk_incls: "0",
    stex_tp: "3",
  });
  const listKey = Object.keys(data).find((k) => Array.isArray(data[k]));
  if (!listKey) throw new Error("순위 응답 파싱 실패: " + JSON.stringify(data).slice(0, 300));
  return data[listKey].slice(0, RULE.SCAN_TOP_N);
}

// ============================================================
// 2단계: 일봉 차트 (ka10081)
// ============================================================
async function getDailyChart(token, stkCd) {
  const data = await callTR(token, "/api/dostk/chart", "ka10081", {
    stk_cd: stkCd,
    base_dt: todayKST(),
    upd_stkpc_tp: "1",
  });
  const listKey = Object.keys(data).find((k) => Array.isArray(data[k]));
  if (!listKey) return null;
  return data[listKey].map((r) => ({
    date: r.dt,
    open: num(r.open_pric),
    high: num(r.high_pric),
    low: num(r.low_pric),
    close: num(r.cur_prc),
    vol: num(r.trde_qty),
  }));
}

// ============================================================
// 3단계: 7조건 채점
// ============================================================
function scoreStock(rankRow, chart) {
  const name = rankRow.stk_nm || rankRow.stk_cd;
  const result = { name, code: rankRow.stk_cd, score: 0, pass: [], fail: [], freshDate: null };

  if (!chart || chart.length < 65) {
    result.fail.push("데이터부족");
    return result;
  }

  const today = chart[0];
  result.freshDate = today.date;
  const past60 = chart.slice(1, 61);
  const past20 = chart.slice(1, 21);

  const trdeAmt = num(rankRow.trde_prica ?? rankRow.trde_amt ?? rankRow.now_trde_prica);
  const rate = signedNum(rankRow.flu_rt ?? rankRow.fluc_rt);

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
    if (ok) { result.score++; result.pass.push(label); }
    else result.fail.push(label);
  }
  result.rate = rate;
  result.trdeAmt = trdeAmt;
  return result;
}

// ============================================================
// 메인 — 무슨 일이 있어도 텔레그램 보고 1통 발송
// ============================================================
async function main() {
  console.log("=== 종가매매 기계 v2 시작 ===", todayKST());
  const token = await getToken();
  const top = await getTopByTradeAmount(token);
  console.log(`거래대금 상위 ${top.length}종목 검사`);

  const results = [];
  let errCount = 0;
  for (const row of top) {
    try {
      const chart = await getDailyChart(token, row.stk_cd);
      const r = scoreStock(row, chart);
      results.push(r);
      console.log(`${r.name} → ${r.score}/7`);
    } catch (e) {
      errCount++;
      console.log(`${row.stk_nm || row.stk_cd} 오류(건너뜀): ${e.message}`);
    }
    await sleep(300);
  }

  if (results.length === 0) throw new Error("전 종목 분석 실패 — API 점검 필요");

  const fresh = results.filter((r) => r.freshDate === todayKST());
  if (fresh.length < results.length * 0.3) {
    await sendTelegram(`📊 종가매매 기계 (${todayKST()})\n오늘은 휴장일이거나 데이터 미갱신입니다.\n매매 없음. 다음 거래일에 다시 보고합니다.`);
    return;
  }

  const green = results.filter((r) => r.score >= 6);
  const yellow = results.filter((r) => r.score === 5);

  let msg = `📊 <b>종가매매 후보 (${todayKST()})</b>\n검사 ${results.length}종목 (오류 ${errCount}건 건너뜀)\n\n`;

  if (green.length === 0 && yellow.length === 0) {
    msg += `🔴 <b>조건 충족 종목 없음 → 오늘 매매 금지</b>\n안 하는 것도 매매다.`;
  } else {
    for (const r of green) {
      msg += `🟢 <b>${r.name}</b> (${r.code}) ${r.score}/7 | +${r.rate}% | ${Math.round(r.trdeAmt / 100)}억\n   미충족: ${r.fail.join(",") || "없음"}\n`;
    }
    for (const r of yellow) {
      msg += `🟡 ${r.name} (${r.code}) 5/7 | +${r.rate}% | 미충족: ${r.fail.join(",")}\n`;
    }
    msg += `\n✅ 직접 확인: ①재료 내일도 가나? ②테마 1등인가?\n⏰ 매수 15:15~15:20 | 하루 1종목\n🚫 미수·몰빵·물타기·추격 금지 | 자동손절 -3.1% 확인`;
  }

  const sent = await sendTelegram(msg);
  if (!sent) throw new Error("텔레그램 발송 3회 실패");
  console.log("=== 보고 완료 ===");
}

main().catch(async (e) => {
  console.error("실행 오류:", e);
  await sendTelegram(`⚠️ 종가매매 기계 오류 발생\n${e.message}\n(깃허브가 자동 재실행합니다)`);
  process.exit(1);
});
