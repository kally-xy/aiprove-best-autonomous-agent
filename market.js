// market.js — public market data + honest, explainable prediction strategy.
//
// Data (all free, no API key):
//   - Crypto (BTC/ETH): Binance public klines via data-api.binance.vision
//     (api.binance.com is geo-blocked from some networks; the vision
//     endpoint is the public mirror).
//   - US stocks/ETFs (SPY/NVDA/GLD): Yahoo Finance chart API
//     (query1.finance.yahoo.com) with a browser User-Agent. Stooq is
//     bot-blocked; Yahoo works.
//
// Strategy — deliberately simple and disclosed, not a black box:
//   - Direction (yes/no, long/short): trend agreement. Compare the
//     short-window return with the long-window return; if both agree
//     the direction is that sign, otherwise fall back to the long window.
//     Confidence is 0.55 (no agreement) to 0.65 (full agreement) —
//     never higher, because a 24h/7d crypto or stock move is mostly noise.
//   - Price targets (SPY/NVDA/GLD closes): last close grown by the mean
//     of the last 5 daily returns, clamped to +/-1% per day, times the
//     number of days ahead. For a near-random walk the best honest guess
//     is close to the last price plus a small drift.

const BINANCE = 'https://data-api.binance.vision/api/v3';
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

// Daily closes for a Binance spot symbol, completed days only.
// The last kline is the in-progress day (close time in the future) and
// is dropped, because "today's close" is not final until UTC midnight.
async function binanceDailyCloses(symbol, limit = 20) {
  const rows = await fetchJson(`${BINANCE}/klines?symbol=${symbol}&interval=1d&limit=${limit}`);
  const now = Date.now();
  const closes = rows
    .filter((r) => r[6] <= now)
    .map((r) => parseFloat(r[4]));
  if (closes.length < 8) throw new Error(`${symbol}: only ${closes.length} completed days`);
  return closes;
}

// Daily closes for a Yahoo symbol (SPY, NVDA, GLD, ...), last trading day last.
async function yahooDailyCloses(symbol, range = '1mo') {
  const d = await fetchJson(`${YAHOO}/${symbol}?range=${range}&interval=1d`, { 'User-Agent': UA });
  const result = d && d.chart && d.chart.result && d.chart.result[0];
  if (!result) throw new Error(`${symbol}: no chart result from Yahoo`);
  const closes = (result.indicators.quote[0].close || []).filter((c) => c != null);
  if (closes.length < 8) throw new Error(`${symbol}: only ${closes.length} closes from Yahoo`);
  return closes;
}

function dailyReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push(closes[i] / closes[i - 1] - 1);
  return out;
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// Direction call from closes. shortN/longN are lookback windows in days.
// Returns { direction: 'yes'|'no', confidence, shortRet, longRet, last }.
function directionCall(closes, shortN, longN) {
  const last = closes[closes.length - 1];
  const shortRet = closes[closes.length - 1] / closes[closes.length - 1 - shortN] - 1;
  const longRet = closes[closes.length - 1] / closes[closes.length - 1 - longN] - 1;
  const sShort = Math.sign(shortRet);
  const sLong = Math.sign(longRet);
  const agree = sShort === sLong && sShort !== 0;
  let dir;
  if (agree) dir = sShort > 0 ? 'yes' : 'no';
  else if (sLong !== 0) dir = sLong > 0 ? 'yes' : 'no';
  else dir = 'yes'; // no signal at all: minimum-confidence default, logged
  const confidence = agree ? 0.65 : 0.55;
  return { direction: dir, confidence, shortRet, longRet, last, agree };
}

// Price target: last close * (1 + drift * days), drift = mean of last 5
// daily returns clamped to +/-1% per day. Rounded to 2 decimals.
function priceTarget(closes, daysAhead) {
  const last = closes[closes.length - 1];
  const rets = dailyReturns(closes).slice(-5);
  const drift = clamp(mean(rets), -0.01, 0.01);
  const target = last * (1 + drift * daysAhead);
  return { target: Math.round(target * 100) / 100, last, drift, daysAhead };
}

module.exports = { binanceDailyCloses, yahooDailyCloses, directionCall, priceTarget, dailyReturns, mean, clamp };
