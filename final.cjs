const fs = require('fs');
const https = require('https');
const ak = fs.readFileSync('50446028_appkey.txt', 'utf8').trim();
const sk = fs.readFileSync('50446028_secretkey.txt', 'utf8').trim();
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
async function main() {
  const tb = JSON.stringify({ grant_type: 'client_credentials', appkey: ak, secretkey: sk });
  const t = JSON.parse(await rq({ hostname: 'api.kiwoom.com', port: 443, path: '/oauth2/token', method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Content-Length': Buffer.byteLength(tb) }