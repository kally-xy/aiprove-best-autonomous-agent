# best-autonomous-agent — a fully autonomous AIProve agent

An agent that, in one run and with no human in the loop, reads
`aiprove.fun/skill.md`, signs in with its own fresh keypair, and enters
and completes as many open bounties as it can on its own. Built for the
AIProve `best-autonomous-agent` bounty (0.3 GLD, "the agent that
completes the most bounties cleanly wins").

## The loop (one run, no human)

1. `GET /skill.md` — the one file an agent reads to compete.
2. Keypair — generated once into `agent.key` (gitignored, mode 600).
   The address is the identity; no signup, no email.
3. `GET /api/auth/challenge?address=0x…` → sign with EIP-191
   `personal_sign` → `POST /api/auth/verify` → bearer token.
4. `GET /api/bounties?status=open` — list what is open.
5. For each bounty it can complete alone: `POST .../enter`, solve,
   `POST .../submit`, record the submission id.
6. `GET /api/me/submissions` — verify every submission landed.
7. The full log is written to `TRANSCRIPT.md` (no secrets in it, ever).

## What it completes on its own

| Bounty | How it solves it |
|---|---|
| `btc-tomorrow`, `forecast-eth-24h`, `forecast-btc-7d` | Direction call (yes/no + confidence) from public Binance daily closes. |
| `signal-eth-pnl-24h` | Same ETH rule, mapped to long/short. |
| `spy-close-1dollar`, `forecast-gold-tomorrow`, `forecast-nvda-3d` | Single-number close target from public Yahoo Finance daily closes. |
| `bug-hunt-utils` | Fetches `utils.js` from the challenge repo, differential-tests it against a hand-written reference, submits the verified bugs. |

## Prediction strategy (honest and disclosed)

All data is public and free, no API key: Binance public klines
(`data-api.binance.vision`) for BTC/ETH, Yahoo Finance chart API for
SPY/NVDA/GLD. See `market.js`.

- **Direction (yes/no, long/short):** trend agreement. The short-window
  return (3d for 24h calls, 7d for the 7d call) and the long-window
  return (7d / 14d) are compared; if both agree, the direction is that
  sign; otherwise the long window decides. Confidence is **0.55** (no
  agreement) to **0.65** (full agreement) — never higher, because a
  24h/7d move is mostly noise and a confident wrong call costs more
  than a hedged one under Brier scoring.
- **Price targets:** last close grown by the mean of the last 5 daily
  returns, clamped to ±1% per day, times the days ahead (1 for
  SPY/GLD, 3 for NVDA). For a near-random walk the best honest guess
  is close to the last price plus a small drift.
- **Bug hunt:** the agent does not hardcode the answers. It fetches
  `utils.js` at runtime, runs it against its own reference
  implementation (`bughunt.js`) on a curated input set — including the
  edge cases where helpers usually break (0/empty, uppercase, emoji /
  astral characters, apostrophes) — and submits only the divergences
  whose expected value is JSON-serialisable. Ambiguous cases (e.g.
  behaviour on invalid input) are not reported.

## Run it

```bash
npm install
npm start
```

Optional env: `API_BASE_URL` (default `https://aiprove.fun`),
`KEYPAIR_PATH` (default `./agent.key`), `HANDLE` (default `prove.agent`).

A run writes `TRANSCRIPT.md` (the full log, committed as the run's
proof) and `session.json` (gitignored — the session token, never
logged, never committed). `agent.key` is gitignored too.

## Files

- `agent.js` — the whole loop: auth, planning, enter/solve/submit, verify.
- `market.js` — public data fetching + prediction strategy.
- `bughunt.js` — bug-hunt module (fetch utils.js, reference, difftest).
- `TRANSCRIPT.md` — transcript of the latest real run.
- `package.json` — one dependency: `ethers` (signing only, no chain calls).

## Honest limitations — what it does NOT do, and why

The agent attempts only what it can genuinely complete alone. From the
21 open bounties at the time of the run:

- **Design bounties** (`make-art`, `write-article`, `make-meme`,
  `aiprove-mascot`, `explainer-video`): need image/video/article
  generation — no media pipeline inside this Node agent. Skipped.
- **Code bounties** (`code-golf-expr`, `fastest-primes`): need real
  optimisation work, not a canned answer. Pasting a known solution
  would not be autonomous completion. Skipped.
- **`sample-agent-skillmd`**: submitting this same agent there would be
  circular. Skipped.
- **`eth-pnl-fixed`**: a backtest on a fixed ETH dataset — needs the
  dataset and a walk-forward strategy, a separate research task.
  Skipped in this run.
- **`top5-pons-24h`**: no free verified data route for pons tokens.
  Skipped.
- **`post-on-x-aiprove`**: needs an X login. Skipped.
- **`refer-most-agents`**: needs other agents to sign up. Skipped.
- **`best-autonomous-agent` itself**: this repo IS the entry; the agent
  does not submit itself.

The forecast calls are weak by design (confidence ≤ 0.65): the point of
this agent is the clean autonomous loop, not a claim to predict markets.
