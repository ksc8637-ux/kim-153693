import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import { scanConvergingStocks, getNaverNews } from "./scanner.js";

const TELEGRAM_TOKEN = "8884127980:AAFdytRmoUnEbkaT3ezLpoxuT_hp3orjukA";
const CHAT_ID = "7375098865";
const CLAUDE_API_KEY = "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";

const claude = new Anthropic({ apiKey: CLAUDE_API_KEY });

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const params = new URLSearchParams({ chat_id: CHAT_ID, text });
  await fetch(`${url}?${params}`);
  console.log("✅ 발송 완료!");
}

async function morningBriefing() {
  try {
    await sendTelegram("📡 오늘 종목 스캔 시작...");
    const stocks = await scanConvergingStocks();
    const news = await getNaverNews();
    let stockText = stocks.length === 0 ? "오늘 수렴 종목 없음" :
      stocks.slice(0, 5).map((s, i) =>
        `${i+1}. ${s.name}(${s.code}) 간격:${s.gap}%`
      ).join("\n");
    const newsText = news.slice(0, 5).join("\n");
    const msg = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: `오늘 브리핑:\n수렴종목:\n${stockText}\n\n뉴스:\n${newsText}\n\n1.주목종목 2.진입전략 3.손절-6% 4.주의사항` }]
    });
    await sendTelegram(`📊 브리핑\n\n${stockText}\n\n${msg.content[0].text}`);
  } catch(e) {
    await sendTelegram(`⚠️ 오류: ${e.message}`);
  }
}

async function shanchoAlert() {
  try {
    const stocks = await scanConvergingStocks();
    const top = stocks.slice(0, 3);
    if (top.length === 0) { await sendTelegram("🎯 샨쵸존: 오늘 없음"); return; }
    const stockText = top.map((s, i) => `${i+1}. ${s.name} 간격${s.gap}%`).join("\n");
    const msg = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      messages: [{ role: "user", content: `샨쵸존 종목:\n${stockText}\n\n진입가/손절가/목표가 분석` }]
    });
    await sendTelegram(`🎯 샨쵸존!\n\n${stockText}\n\n${msg.content[0].text}`);
  } catch(e) {
    await sendTelegram(`⚠️ 오류: ${e.message}`);
  }
}

async function eveningAlert() {
  try {
    const news = await getNaverNews();
    const newsText = news.slice(0, 5).join("\n");
    const msg = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      messages: [{ role: "user", content: `뉴스:\n${newsText}\n\n종가베팅 후보 3개 (손절가/목표가 포함)` }]
    });
    await sendTelegram(`🌙 종가베팅\n\n${msg.content[0].text}`);
  } catch(e) {
    await sendTelegram(`⚠️ 오류: ${e.message}`);
  }
}

cron.schedule("40 7 * * 1-5", morningBriefing, { timezone: "Asia/Seoul" });
cron.schedule("50 8 * * 1-5", shanchoAlert, { timezone: "Asia/Seoul" });
cron.schedule("0 15 * * 1-5", eveningAlert, { timezone: "Asia/Seoul" });

console.log("🤖 샨쵸 주식비서 풀버전 가동!");
await sendTelegram("✅ 업그레이드 완료!\n📊 7:40 실제스캔+브리핑\n🎯 8:50 샨쵸존\n🌙 15:00 종가베팅");