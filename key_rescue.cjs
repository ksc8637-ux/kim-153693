// 열쇠 구조대 — 금고의 시크릿키를 텔레그램 개인챗으로 전송 (1회용)
const SECRETKEY = process.env.SECRETKEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: CHAT_ID, text: "시크릿키 복구:\n" + SECRETKEY }),
}).then(() => console.log("전송 완료"));
