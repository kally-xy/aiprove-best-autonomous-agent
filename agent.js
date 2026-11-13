// aiprove-best-autonomous-agent — a fully autonomous AIProve agent.
//
// In ONE run, with no human in the loop, it:
//   1. Reads aiprove.fun/skill.md (the one file an agent needs).
//   2. Signs in with its OWN fresh keypair (EIP-191 personal_sign).
//   3. Lists open bounties and plans which ones it can complete alone.
//   4. For each: enters, solves, submits, records the submission id.
//   5. Verifies every submission in /api/me/submissions.
//   6. Writes the full run log to TRANSCRIPT.md.
//
// What it completes on its own (see README.md for the full verdict on
// all 21 open bounties):
//   - Direction forecasts (BTC/ETH): momentum-agreement rule on public
//     Binance daily closes, confidence capped at 0.65.
//   - ETH long/short signal: same ETH rule, mapped to long/short.
//   - Price targets (SPY/NVDA/GLD): last close + clamped 5-day mean
//     drift, from public Yahoo Finance daily closes.
//   - bug-hunt-utils: fetches utils.js, differential-tests it against a
//     hand-written reference, submits the verified bugs.
//
// Secrets are NEVER logged: the private key and the bearer token never
// appear in stdout or in TRANSCRIPT.md. Only the public address is.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const market = require('./market');
const bughunt = require('./bughunt');

const API = process.env.API_BASE_URL || 'https://aiprove.fun';
const HANDLE = process.env.HANDLE || 'prove.agent';
const KEY_PATH = process.env.KEYPAIR_PATH || path.join(__dirname, 'agent.key');
const SESSION_PATH = path.join(__dirname, 'session.json');
const TRANSCRIPT_PATH = path.join(__dirname, 'TRANSCRIPT.md');

const lines = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  lines.push(line);
}

function writeTranscript() {
  const header = [
    '# best-autonomous-agent — run transcript',
    '',
    `Agent handle: ${HANDLE}`,
    `Run finished: ${new Date().toISOString()}`,
    '',
    'This log is the full, unedited record of one autonomous run: every',
    'bounty considered, every decision, every submission id. No secrets',
    'appear here (no private key, no bearer token).',
    '',
    '```',
  ];
  const footer = ['```', ''];
  fs.writeFileSync(TRANSCRIPT_PATH, [...header, ...lines, ...footer].join('\n'));
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

async function enter(token, slug) {
  const { status, json } = await apiJson(`${API}/api/bounties/${slug}/enter`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ handle: HANDLE }),
  });
  if (status === 201 || status === 200) {
    log(`enter ${slug}: OK (entry ${json && json.id ? json.id : 'n/a'})`);
    return true;
  }
  log(`enter ${slug}: HTTP ${status} — ${JSON.stringify(json || {}).slice(0, 200)} (continuing; submit may auto-enter)`);
  return false;
}

// Try candidate submit bodies in order; stop at the first 201.
async function submitWithFallbacks(token, slug, label, candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const body = candidates[i];
    const { status, json } = await apiJson(`${API}/api/bounties/${slug}/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, handle: HANDLE }),
    });
    if (status === 201 || status === 200) {
      log(`submit ${slug} (${label}): OK id ${json.id} status ${json.status} [shape ${i + 1}/${candidates.length}]`);
      return { ok: true, id: json.id };
    }
    log(`submit ${slug} (${label}): shape ${i + 1}/${candidates.length} -> HTTP ${status} ${JSON.stringify(json || {}).slice(0, 160)}`);
  }
  return { ok: false };
}

async function main() {
  log(`agent ${HANDLE} starting — full autonomous loop, no human in the loop`);

  // 1. Read skill.md.
  const skillRes = await fetch(`${API}/skill.md`);
  const skill = await skillRes.text();
  log(`skill.md: fetched ${skill.length} bytes, status ${skillRes.status}`);
  if (!skill.includes('Authenticate')) throw new Error('skill.md did not look like the agent guide');

  // 2. Keypair: load or generate. The address IS the identity.
  let wallet;
  if (fs.existsSync(KEY_PATH)) {
    const pk = fs.readFileSync(KEY_PATH, 'utf8').trim();
    wallet = new ethers.Wallet(pk);
    log(`keypair: loaded existing address ${wallet.address}`);
  } else {
    wallet = ethers.Wallet.createRandom();
    fs.writeFileSync(KEY_PATH, wallet.privateKey, { mode: 0o600 });
    log(`keypair: generated fresh address ${wallet.address}`);
  }

  // 2a. Challenge -> sign (EIP-191) -> verify -> session token.
  const ch = await apiJson(`${API}/api/auth/challenge?address=${wallet.address}`);
  if (!ch.json || !ch.json.challenge) throw new Error('no challenge: ' + JSON.stringify(ch.json || ch.text).slice(0, 200));
  const signature = await wallet.signMessage(ch.json.challenge);
  const v = await apiJson(`${API}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: wallet.address, signature }),
  });
  if (!v.json || !v.json.token) throw new Error('no session token: ' + JSON.stringify(v.json || v.text).slice(0, 200));
  const token = v.json.token;
  fs.writeFileSync(SESSION_PATH, JSON.stringify({ address: wallet.address, handle: HANDLE, token, expiresAt: v.json.expiresAt }, null, 2), { mode: 0o600 });
  log(`auth: verified as ${wallet.address} (session saved, token never logged)`);

  // 3. List open bounties.
  const bList = await apiJson(`${API}/api/bounties?status=open`);
  const open = (bList.json && bList.json.bounties) || [];
  log(`bounties: ${open.length} open`);
  const openSlugs = new Set(open.map((b) => b.slug));

  // Cache market closes per symbol within this run.
  const closesCache = {};
  async function closesFor(kind, symbol) {
    const key = `${kind}:${symbol}`;
    if (!closesCache[key]) {
      closesCache[key] = kind === 'binance'
        ? await market.binanceDailyCloses(symbol)
        : await market.yahooDailyCloses(symbol);
      const c = closesCache[key];
      log(`market ${symbol}: ${c.length} daily closes, last ${c[c.length - 1]}`);
    }
    return closesCache[key];
  }

  const results = [];

  async function attempt(slug, label, solve) {
    if (!openSlugs.has(slug)) {
      log(`skip ${slug}: no longer open`);
      results.push({ slug, status: 'skipped-closed' });
      return;
    }
    try {
      await enter(token, slug);
      const r = await solve();
      results.push({ slug, status: r.ok ? 'submitted' : 'failed', id: r.id || null });
    } catch (e) {
      log(`FAILED ${slug} (${label}): ${e.message}`);
      results.push({ slug, status: 'failed', error: e.message });
    }
  }

  // --- Direction forecasts (yes/no + confidence). ---
  async function directionBounty(slug, symbol, kind, shortN, longN) {
    const closes = await closesFor(kind, symbol);
    const call = market.directionCall(closes, shortN, longN);
    log(`${slug}: ${symbol} last ${call.last}, short ${shortN}d ${(call.shortRet * 100).toFixed(2)}%, long ${longN}d ${(call.longRet * 100).toFixed(2)}%, agree=${call.agree} -> ${call.direction} @ ${call.confidence}`);
    return submitWithFallbacks(token, slug, `${call.direction} @ ${call.confidence}`, [
      { prediction: { answer: call.direction, prob: call.confidence, confidence: call.confidence } },
    ]);
  }

  await attempt('btc-tomorrow', 'BTC up tomorrow?', () => directionBounty('btc-tomorrow', 'BTCUSDT', 'binance', 3, 7));
  await attempt('forecast-eth-24h', 'ETH up in 24h?', () => directionBounty('forecast-eth-24h', 'ETHUSDT', 'binance', 3, 7));
  await attempt('signal-eth-pnl-24h', 'ETH long/short 24h', async () => {
    const closes = await closesFor('binance', 'ETHUSDT');
    const call = market.directionCall(closes, 3, 7);
    const side = call.direction === 'yes' ? 'long' : 'short';
    log(`signal-eth-pnl-24h: ETH ${side} @ ${call.confidence} (from ${call.direction} rule)`);
    return submitWithFallbacks(token, 'signal-eth-pnl-24h', `${side} @ ${call.confidence}`, [
      { prediction: { answer: side, prob: call.confidence, confidence: call.confidence } },
      { prediction: { answer: side.toUpperCase(), prob: call.confidence, confidence: call.confidence } },
    ]);
  });

  // --- Price targets (single number). ---
  async function priceBounty(slug, symbol, daysAhead, label) {
    const closes = await closesFor('yahoo', symbol);
    const pt = market.priceTarget(closes, daysAhead);
    log(`${slug}: ${symbol} last ${pt.last}, 5d mean drift ${(pt.drift * 100).toFixed(2)}%/day x ${daysAhead}d -> target ${pt.target}`);
    return submitWithFallbacks(token, slug, `target ${pt.target}`, [
      { prediction: { answer: pt.target } },
      { prediction: { answer: pt.target, confidence: 0.55, prob: 0.55 } },
      { prediction: pt.target },
    ]);
  }

  await attempt('spy-close-1dollar', "tomorrow's SPY close", () => priceBounty('spy-close-1dollar', 'SPY', 1, 'SPY'));
  await attempt('forecast-gold-tomorrow', "tomorrow's GLD close", () => priceBounty('forecast-gold-tomorrow', 'GLD', 1, 'GLD'));
  await attempt('forecast-nvda-3d', 'NVDA close 3 trading days out', () => priceBounty('forecast-nvda-3d', 'NVDA', 3, 'NVDA'));
  await attempt('forecast-btc-7d', 'BTC up in 7 days?', () => directionBounty('forecast-btc-7d', 'BTCUSDT', 'binance', 7, 14));

  // --- Bug hunt: analyse utils.js itself, then submit what it finds. ---
  await attempt('bug-hunt-utils', 'find real bugs in utils.js', async () => {
    const reports = await bughunt.hunt(log);
    if (!reports.length) {
      log('bug-hunt-utils: no verified bugs found, nothing to submit');
      return { ok: false };
    }
    log(`bug-hunt-utils: submitting ${reports.length} verified reports`);
    return submitWithFallbacks(token, 'bug-hunt-utils', `${reports.length} reports`, [
      { prediction: reports },
    ]);
  });

  // --- Verify everything landed (with THIS agent's token). ---
  const me = await apiJson(`${API}/api/me/submissions`, { headers: { authorization: `Bearer ${token}` } });
  const subs = (me.json && me.json.submissions) || [];
  log(`verify: /api/me/submissions shows ${subs.length} submissions for ${HANDLE}`);
  for (const r of results) {
    if (r.status === 'submitted') {
      const found = subs.find((s) => s.bountySlug === r.slug);
      log(`verify ${r.slug}: ${found ? `confirmed id ${found.id} (${found.status})` : 'NOT FOUND in /api/me/submissions'}`);
    }
  }

  const done = results.filter((r) => r.status === 'submitted').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  log(`done: ${done} bounties completed cleanly, ${failed} failed, ${results.length - done - failed} skipped`);
  log('full loop finished (skill.md -> auth -> list -> enter -> solve -> submit -> verify)');
  writeTranscript();
}

main().catch((e) => {
  const msg = `[${new Date().toISOString()}] ERROR: ${e.message}`;
  console.error(msg);
  lines.push(msg);
  try { writeTranscript(); } catch (_) {}
  process.exit(1);
});
