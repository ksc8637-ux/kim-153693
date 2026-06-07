// scanner.js - 네이버 금융 실제 데이터 크롤링 + 이동평균선 수렴 스캔
import axios from "axios";
import * as cheerio from "cheerio";

async function getStockData(code, days = 70) {
  try {
    const url = `https://finance.naver.com/item/sise_day.naver?code=${code}&page=1`;
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://finance.naver.com" }
    });
    const $ = cheerio.load(res.data);
    const prices = [];
    $("tr").each((i, el) => {
      const tds = $(el).find("td");
      if (tds.length >= 2) {
        const dateText = $(tds[0]).text().trim();
        const closeText = $(tds[1]).text().trim().replace(/,/g, "");
        if (dateText.match(/\d{4}\.\d{2}\.\d{2}/) && closeText) {
          prices.push(parseFloat(closeText));
        }
      }
    });
    return prices;
  } catch (e) {
    return [];
  }
}

function calcMA(prices, period) {
  if (prices.length < period) return null;
  const sum = prices.slice(0, period).reduce((a, b) => a + b, 0);
  return sum / period;
}

function isConverging(ma5, ma20, ma60, threshold = 3.0) {
  if (!ma5 || !ma20 || !ma60) return false;
  const max = Math.max(ma5, ma20, ma60);
  const min = Math.min(ma5, ma20, ma60);
  const gap = ((max - min) / min) * 100;
  return gap <= threshold;
}

async function getTopStocks() {
  try {
    const url = "https://finance.naver.com/sise/sise_quant.naver?sosok=1";
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://finance.naver.com" }
    });
    const $ = cheerio.load(res.data);
    const stocks = [];
    $("tr").each((i, el) => {
      const tds = $(el).find("td");
      if (tds.length >= 2) {
        const link = $(tds[1]).find("a").attr("href");
        const name = $(tds[1]).find("a").text().trim();
        if (link && link.includes("code=")) {
          const code = link.split("code=")[1];
          if (code && name) stocks.push({ code, name });
        }
      }
    });
    return stocks.slice(0, 50);
  } catch (e) {
    return [];
  }
}

export async function scanConvergingStocks() {
  console.log("📡 종목 스캔 시작...");
  const stocks = await getTopStocks();
  const results = [];
  for (const stock of stocks) {
    const prices = await getStockData(stock.code);
    if (prices.length < 60) continue;
    const ma5 = calcMA(prices, 5);
    const ma20 = calcMA(prices, 20);
    const ma60 = calcMA(prices, 60);
    if (isConverging(ma5, ma20, ma60, 3.0)) {
      const gap = (((Math.max(ma5, ma20, ma60) - Math.min(ma5, ma20, ma60)) / Math.min(ma5, ma20, ma60)) * 100).toFixed(2);
      results.push({ name: stock.name, code: stock.code, ma5: Math.round(ma5), ma20: Math.round(ma20), ma60: Math.round(ma60), gap: gap });
    }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`✅ 스캔 완료: ${results.length}개 수렴 종목 발견`);
  return results;
}

export async function getNaverNews() {
  try {
    const url = "https://finance.naver.com/news/news_list.naver?mode=LSS2D&section_id=101&section_id2=258";
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://finance.naver.com" }
    });
    const $ = cheerio.load(res.data);
    const news = [];
    $("dl dt a").each((i, el) => {
      const title = $(el).text().trim();
      if (title && i < 10) news.push(title);
    });
    return news;
  } catch (e) {
    return [];
  }
}