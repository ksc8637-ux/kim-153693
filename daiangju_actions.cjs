const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const APPKEY = process.env.APPKEY;
const SECRETKEY = process.env.SECRETKEY;

let accessToken = null;

async function getAccessToken() {
  const res = await fetch('https://api.kiwoom.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: APPKEY, secretkey: SECRETKEY })
  });
  const data = await res.json();
  accessToken = data.token;
}

async function sendTelegram(chatId, message) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
  });
}

async function getVolumeRanking() {
  const res = await fetch('https://api.kiwoom.com/api/dostk/rkinfo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, 'api-id': 'ka90003' },
    body: JSON.stringify({ mrkt_tp: '0', sort_tp: '1', stk_cnd: '0', trde_qty_tp: '0', pri_range_strt: '0', pri_range_end: '0', trde_prica_range_strt: '0', trde_prica_range_end: '0' })
  });
  return await res.json();
}

function formatNumber(n) {
  return Number(n).toLocaleString('ko-KR');
}

async function main() {
  try {
    console.log('주식비서 시작...');
    await getAccessToken();
    console.log('토큰 발급 완료');

    const volumeData = await getVolumeRanking();
    const stocks = volumeData?.output || [];
    const top7 = stocks.slice(0, 7);

    let message = '🌏 미국 시장\n\n🎯 오늘 핫 테마 (키움 집계)\n\n⚡ 종가매매 후보 TOP7\n\n';

    for (let i = 0; i < top7.length; i++) {
      const s = top7[i];
      const price = Number(s.cur_prc || 0);
      const rate = Number(s.flu_rt || 0);
      const vol = Number(s.trde_qty || 0);
      const stop = Math.round(price * 0.94);
      const stopGap = Math.round(price * 0.97);
      const target = Math.round(price * 1.05);

      message += `⭐ ${i+1}위. ${s.stk_nm}\n`;
      message += `현재가: ${formatNumber(price)}원 | 등락: ${rate > 0 ? '+' : ''}${rate}%\n`;
      message += `거래량: ${formatNumber(vol)}\n`;
      message += `✅ 진입가: ${formatNumber(price)}원 (종가 매수)\n`;
      message += `🔴 손절가: ${formatNumber(stop)}원 (-6%)\n`;
      message += `⚡ 갭하락손절: ${formatNumber(stopGap)}원 (시초가 -3% 이하시)\n`;
      message += `🎯 내일목표: ${formatNumber(target)}원 (+5%)\n\n`;
    }

    message += '━━━━━━━━━━━━━━━━\n';
    message += '📌 진입: 14:50~15:00 종가 매수\n';
    message += '📌 매도: 내일 9:00~9:05 시초가 전량\n';
    message += '📌 손절: -6% (0624 필수 등록)\n\n';
    message += '🔴 철칙\n✅ 미수 절대 금지\n⚡ 오늘 못 잡으면 내일 또 온다';

    await sendTelegram(CHAT_ID, message);
    console.log('발송 완료!');

  } catch (err) {
    console.error('오류:', err.message);
    await sendTelegram(CHAT_ID, `❌ 오류: ${err.message}`).catch(() => {});
  }
}

main();