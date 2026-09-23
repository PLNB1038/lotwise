# Lotwise


A corporate actions engine for tokenized equities on Solana. Lotwise normalizes splits, dividends, mergers, ticker changes and multiplier rebases across xStocks, PreStocks, Backpack and Tessera tokens into adjusted tax lots, and serves them over a REST API with a self-hosted report page.

## Problem

Tokenized equity issuers rebase positions when corporate actions happen. In the xStocks model the raw balance never changes: a supply multiplier (Token-2022 `scaledUiAmountConfig`) scales the displayed quantity instead. Other issuers rotate mints outright. The event data behind these rebases lives in issuer APIs and, for some issuers, only in on-chain mint state. There is no normalized, queryable source of corporate actions for tokenized equities. Portfolio trackers do not model them at all, and generic crypto tax services treat every mint as an ordinary token with no concept of a split, dividend accrual, merger or ticker change.

The result is silent breakage. Cost basis and P&L computed from raw transaction history are wrong after the first split or dividend. A ticker change orphans the old symbol. A mint rotation makes a wallet look like it sold the entire position at a nonsensical price. Nothing in standard tooling flags any of this, so the numbers stay wrong until a human notices.

Lotwise closes that gap with one canonical event stream, verified against the chain, and tax lots adjusted from it.

## What it does

- **Token registry**: 31 tokenized equities from 4 issuers (xStocks/Backed 16, PreStocks 8, Backpack 4, Tessera 3). Token-2022 mints — decimals per issuer family: 8 (xStocks), 6 (Backpack), 9 (PreStocks/Tessera) — every mint and its decimals verified against mainnet.
- **Canonical events**: one schema, 6 event types (`SPLIT`, `DIVIDEND_ACCRUAL`, `MERGER`, `TICKER_CHANGE`, `REDEEM`, `MULTIPLIER_CHANGE`). Strict validation: canonical ISO-8601 dates, exact decimal multipliers as strings (no floats), mandatory source references.
- **Event sources**: the xStocks issuer API (paginated history with a completeness check: the oldest node must start at multiplier `1`), and for PreStocks/Backpack the mint state itself, read via an on-chain journal that backfills and diffs across restarts.
- **Adjusted lots**: FIFO lots rebuilt from wallet history and adjusted through the multiplier timeline, with exact dust arithmetic (BigInt rationals; `sampleScaledQty` reports the exact remainder).
- **Price cross-check**: daily GeckoTerminal candles around event dates, per-event verdicts (`consistent` / `mismatch` / `suspicious` / `inconclusive` / `no-price-data`).
- **Fail-closed reconcile**: issuer-reported multiplier vs live on-chain Scaled UI amount. An unavailable source is a `503`, never a fabricated value; tokens with a broken multiplier history are excluded from reporting and flagged with a reason, not silently shown as `1`.
- **Report page and REST API**: the page at `/` is a working sample consumer of the API. Zero runtime dependencies (`node:http` and the standard library only).

## Quickstart

Requires Node 24+. There is no install step; there are no runtime dependencies.

```sh
node scripts/serve.mjs
```

Then open http://127.0.0.1:8787/ .

On startup the server loads the registry, reads mint state for every non-xStocks token, pulls xStocks multiplier history, and only then starts listening. Unavailable sources are skipped with a warning instead of crashing the boot; the state of every source is visible at `/health`.

Flags: `--port 8787`, `--host 127.0.0.1`, `--rpc https://api.mainnet-beta.solana.com` (any Solana JSON-RPC endpoint), `--max-txs 300` (per-wallet signature cap for `/lots`).

## API

GET only. Token endpoints accept `?mint=` or `?symbol=` and return `400` for anything outside the registry instead of returning empty data. Dates are strict ISO-8601: `2026-02-30` is rejected, not rolled over to March.

| Endpoint | Purpose |
|---|---|
| `/summary` | All tracked tokens with event counts and current multipliers |
| `/tokens?issuer=` | Registry listing, optional issuer filter |
| `/events?symbol=&type=` | Canonical events for one token, optional type filter |
| `/multiplier?symbol=&date=&raw=` | Multiplier at a date plus a raw-to-adjusted sample with exact dust |
| `/onchain?symbol=&date=` | Issuer-reported vs on-chain multiplier reconcile verdict |
| `/lots?address=` | Wallet report: FIFO lots, raw vs adjusted balances |
| `/accruals?symbol=&address=` | Dividend accruals of one token for one wallet (engine-computed) |
| `/crosscheck?symbol=` | Price cross-check verdicts per event |
| `/health` | Event/token counts, journal and registry integrity flags, excluded tokens |

Examples:

```sh
# Health: token and event counts, journal/replay state, excluded tokens with reasons
curl http://127.0.0.1:8787/health

# Events for SPYx
curl "http://127.0.0.1:8787/events?symbol=SPYx"

# Multiplier for SPYx on a date, with a raw-to-adjusted sample.
# raw=100000000 means one whole token at 8 decimals; the response reports exact dust.
curl "http://127.0.0.1:8787/multiplier?symbol=SPYx&date=2026-07-01&raw=100000000"

# Reconcile issuer plan vs live on-chain Scaled UI amount for SPACEX
curl "http://127.0.0.1:8787/onchain?symbol=SPACEX"

# Wallet report: FIFO lots, raw vs adjusted balances, scan completeness
curl "http://127.0.0.1:8787/lots?address=$WALLET_ADDRESS"

# Price cross-check: daily candles vs event dates for OPENAI
curl "http://127.0.0.1:8787/crosscheck?symbol=OPENAI"
```

## Architecture

`scripts/serve.mjs` wires everything together: registry, then events from both source families, then the API server. Modules under `src/`:

- `registry/` token registry (`data/tokens.json`). Corrupt file is an explicit state: the evidence is preserved next to the original, boot continues on an empty registry, corruption is flagged in `/health`.
- `schema/` canonical event validation and a strict ISO-8601 date parser shared by every layer.
- `events/` normalization from xStocks history and on-chain mint state; the on-chain journal (backfill, replay across restarts, read-only mode when evidence preservation fails); the price cross-check.
- `issuer/` xStocks API client and the Token-2022 `scaledUiAmountConfig` parser.
- `ingest/` JSON-RPC client, signature listing, transaction parsing.
- `lots/` multiplier timeline (exact rational arithmetic) and the lot engine. A `MERGER` without an exchange ratio is stored as an informational event but refused by the lot engine: it will not guess.
- `price/` GeckoTerminal client (pool discovery, daily OHLCV), pool orientation handled explicitly.
- `reconcile/` issuer vs on-chain multiplier verdicts.
- `wallet/` wallet history scan and FIFO lot report. Scan gaps are surfaced honestly (`complete: false`), never hidden.
- `api/` REST server on `node:http`. Bad timeline data excludes a token from reporting with a recorded reason instead of killing the process.
- `ui/` the report page.
- `webhooks/` subscription store and HMAC-SHA256 signed deliveries with retries (`scripts/webhook-deliver.mjs` CLI).
- `fs/` atomic file writes.

Live on-chain findings observed during development: SPACEX multiplier `1` → `5` effective 2026-06-10, OPENAI `1` → `1.4861347` effective 2026-07-17. Tessera tokens have no rebase mechanism; their multiplier is `1`, and the API says so plainly.

## Testing

```sh
node --test test/*.test.mjs
```

628 tests, all green (plain `node:test`; no mocks for the core paths — the lot engine, timeline and reconcile are tested as pure functions on real-shaped data).

## Status

Built for the Colosseum Crypto World's Fair hackathon (Solana track), September 14 to October 12, 2026.

Lotwise is read-only infrastructure. It writes nothing to mainnet, ships no SPL programs of its own, introduces no new token and no protocol for users to opt into. The only mutable state is local data files under `data/`, which are rebuilt from chain and issuer APIs on boot.

## License

MIT — see [LICENSE](LICENSE).
