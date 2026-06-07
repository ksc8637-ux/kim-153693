const fs = require('fs');
const https = require('https');
const appkey = fs.readFileSync('50446028_appkey.txt', 'utf8').trim();
const secretkey = fs.readFileSync('50446028_secretkey.txt', 'utf8').trim();
function req(opt, body) {
  return new Promise((res, rej) => {
    const r = https.request(opt, (response) => {
      let d = '';
      response.on('data', c => d += c);
      response.on('end', () => res(d));
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}
async function main() {
  const tb = JSON.stringify({grant_type:'client_credentials',appkey,secretkey});
  const tr = await req({hostname:'api.kiwoom.com',port:443,path:'/oauth2/token',method:'POS