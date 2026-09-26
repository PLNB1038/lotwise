# <img src="assets/logo-mark.svg" alt="Lotwise" width="28" height="28"> Lotwise

[![tests](https://github.com/PLNB1038/lotwise/actions/workflows/tests.yml/badge.svg)](https://github.com/PLNB1038/lotwise/actions/workflows/tests.yml)


A corporate actions engine for tokenized equities on Solana. Lotwise normalizes splits, dividends, mergers, ticker changes and multiplier rebases across xStocks, PreStocks, Backpack and Tessera tokens into adjusted tax lots, and serves them over a REST API with a self-hosted report page.

## Problem

Tokenized equity issuers rebase positions when corporate actions happen. In the xStocks model the raw balance never changes: a supply multiplier (Token-2022 `scaledUiAmountConfig`) scales the displayed quantity instead. Other issuers rotate mints outright. The event data behind these rebases lives in issuer APIs and, for some issuers, only in on-chain mint state. There is no normalized, queryable source of corporate actions for tokenized equities. Portfolio trackers do not model them at all, and generic crypto tax services treat every mint as an ordinary token with no concept of a split, dividend accrual, merger or ticker change.

The result is silent breakage. Cost basis and P&L computed from raw transaction history are wrong after the first split or dividend. A ticker change orphans the old symbol. A mint rotation makes a wallet look like it sold the entire position at a nonsensical price. Nothing in standard tooling flags any of this, so the numbers stay wrong until a human notices.

Lotwise closes that gap with one canonical event stream, verified against the chain, and tax lots adjusted from it.

## What it does

- **Token registry**: 31 tokenized equities from 4 issuers (xStocks/Backed 16, PreStocks 8, Backpack 4, Tessera 3). Token-2022 mints — decimals per issuer family: 8 (xStocks), 6 (Backpack), 9 (PreStocks/Tessera) — every mint and its decimals verified against mainnet.
- **Canonical events**: one schema, 6 event types (`SPLIT`, `DIVIDEND_ACCRUAL`, `MERGER`, `TICKER_CHANGE`, `REDEEM`, `MULTIPLIER_CHANGE`). Strict validation: canonical ISO-8601 dates, exact decimal multipliers as strings (no floats), mandatory source references. All six are schema-validated and engine-ready; today's live feed produces `MULTIPLIER_CHANGE` (xStocks issuer history and the on-chain journal) — the rest appear the moment an issuer or operator supplies them.
- **Event sources**: the xStocks issuer API (paginated history with a completeness check: the oldest node must start at multiplier `1`), and for PreStocks/Backpack the mint state itself, read via an on-chain journal that backfills and diffs across restarts.
- **Adjusted lots**: FIFO lots rebuilt from wallet history and adjusted through the multiplier timeline, with exact dust arithmetic (BigInt rationals; `sampleScaledQty` reports the exact remainder). Swaps against a **USDC leg carry their cost basis**: a lot bought against USDC knows its `basisRaw`, a disposal against USDC books `proceedsRaw` and `pnlRaw` per FIFO piece (basis transfers proportionally with exact trunc-remainder accounting). A trade without a USDC leg — a transfer, a token→token swap, several tracked tokens inside one tx — is flagged `basisKnown: false` / `proceedsKnown: false`, never an invented number.
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

Flags: `--port 8787`, `--host 127.0.0.1`, `--rpc https://api.mainnet-beta.solana.com` (any Solana JSON-RPC endpoint), `--max-txs 300` (signature cap **per source** — the owner address and each token account — for wallet scans). The port is probed for availability and the host is resolved before boot spends any RPC quota.

## API

GET (and HEAD) only. Token endpoints accept `?mint=` or `?symbol=` and return `400` for anything outside the registry instead of returning empty data. Dates are strict ISO-8601: `2026-02-30` is rejected, not rolled over to March.

| Endpoint | Purpose |
|---|---|
| `/summary` | All tracked tokens with event counts and current multipliers |
| `/tokens?issuer=` | Registry listing, optional issuer filter (`backed`, `prestocks`, `backpack`, `tessera`) |
| `/events?symbol=&type=` | Canonical events for one token, optional type filter |
| `/multiplier?symbol=&date=&raw=` | Multiplier at a date plus a raw-to-adjusted sample with exact dust |
| `/onchain?symbol=&date=` | Issuer-reported vs on-chain multiplier reconcile verdict |
| `/lots?address=` | Wallet report: FIFO lots with cost basis, raw vs adjusted balances, realized P&L from USDC legs; `moneyOnly` rows list USDC the pricing did not consume (a same-tx round-trip spread — alone or mixed with a trade whose pricing was withdrawn, a multi-token swap's fee, or a plain transfer) — a signed net per mint, deliberately outside lots/realized/gaps. The pricing is also withdrawn when a tracked account is merely SEEN in the same tx's balances with no balance change (a passive approval, an empty account): whether it moved and returned is not recoverable from balances, so the trade stays unpriced and the money a fact row — conservative by design. One wallet scan runs at a time: a concurrent scan request answers `503` with `kind: "scan-busy"` and `Retry-After` (a real scan holds the RPC queue for minutes; queuing a second one would starve every other endpoint). The economic result of the window is assembled by the consumer as: Σ `pnlRaw` + Σ `moneyOnly` nets − Σ `basisRaw` of disposals with `proceedsKnown: false` and `basisKnown: true` + Σ `proceedsRaw` of disposals with `proceedsKnown: true` and `basisKnown: false` (a priced sale of an unbased lot: money received, basis unknown) + Σ `gaps[].proceedsRaw` (the hole's own sale share — really received money) |
| `/accruals?symbol=&address=` | Dividend accruals of one token for one wallet. The base is the position held **at the start of the ex-date** (its UTC midnight — a buy during the ex-date itself does not qualify), replayed from the scan window — a sale after the ex-date does not shrink the dividend; rows flag `baseIncomplete` when a transaction cannot be ordered against the ex-date, the scan has gaps, the window was truncated, or the scan's net delta did not reconcile with the live chain, and answer `totalRaw: null` (never a negative number) when the window saw only disposals. A dividend's identity is its calendar ex-day and per-unit amount — the same dividend from two sources accrues once. Two declarations naming different ex-days are two dividends — including two timezone skins of one instant (the declared ex-day is the economic fact); the declarations channel is append-only, so a corrected re-declaration would double the income until resolved — the loader warns about same-amount declarations within three days. **To express a correction, do not re-declare — supersede**: append a new line for the same symbol carrying `supersedes: {"exDate": "...", "amountPerUnitRaw": "..."}` naming the replaced declaration by its identity (the canonical ex-day and the per-unit amount as originally declared; the correction may carry a new ex-day, a new amount, or both). The replacement removes the superseded line's accrual — the corrected amount accrues alone, `/health` shows `declarations.superseded`. The reference is one level deep and must resolve: a missing target, a correction of a correction, a self-reference, or two corrections on one target refuse the whole file at load (`declarations.ok: 0`, the reason in the boot log) — a half-applied correction would leave the stale amount accruing, which is the doubling this field exists to prevent. Lines without the field accrue exactly as before. Accruals come from operator-supplied dividend declarations — `data/declarations.json`, loaded at boot, one line per declaration: `{symbol, exDate, amountPerUnitRaw, decimals, sourceUrl}` (`amountPerUnitRaw` is per RAW unit — a per-share declaration must be divided by the ex-date multiplier before submission); xStocks publishes no per-unit amounts, so in the live feed today dividend rebases appear as multiplier events. A `200 []` here is either "no dividends" or "the declarations channel is down" — the separator is the response header `X-Declarations-Unavailable: 1` (present only when the channel refused the file; the mirror lives in `/health` `declarations.ok`) |
| `/crosscheck?symbol=` | Price cross-check verdicts per event (its `ratio` is the one non-string decimal — a float) |
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

### Response and error contract

Every response is JSON; decimal quantities are strings everywhere (including `amountPerUnitRaw` in `/events`); `/events` rows are chronological. Errors are `{"error": string, "kind"?: string}` — `kind` is the retry policy. Transient (back off and retry): `rate-limit` and `network`. `rate-limit` arrives in two shapes: our own 429 (body `kind: "rate-limit"`, header `Retry-After`) and an upstream RPC refusal relayed as `503` with the same kind but no `Retry-After` — both count against the scan budget, so a blind retry loop only exhausts it faster; back off in both cases. Not retryable — the upstream source refused or sent garbage, and the endpoint answers `503` without fabricating data: `rpc`, `http`, `parse` (a price source returned an unusable body), `malformed-source` (an RPC source returned a non-array response). A few untyped internal checks reject with `"kind": null`. A `400` means the request itself is wrong — unknown symbol/mint/issuer/type, a rolled-over date, a structurally invalid address — and will fail identically on every retry.

Response shape (a real `/events` row, truncated):

```json
{"type":"MULTIPLIER_CHANGE","effectiveDate":"2026-02-02T21:47:00.000Z","status":"confirmed",
 "sources":["https://api.xstocks.fi/api/v2/public/assets/JPMx/multiplier/history?network=Ethereum#node:…"],
 "multiplierFrom":"1.0040015369331659","multiplierTo":"1.007154790830491","reason":"Dividend",
 "mint":"XsMAqkcKsUewDrzVkait4e5u4y8REgtyS7jWgCpLV2C"}
```

Wallet scans (`/lots`, `/accruals`) walk full transaction history synchronously — an active wallet can take minutes. The report says so instead of hiding it: `complete: false`, per-token `gaps`, and `truncated` when the signature cap was hit. Pricing is honest about what it knows: realized rows carry `basisRaw` / `proceedsRaw` / `pnlRaw` only when the trade had a USDC leg; the rest are marked unpriced, and a gap piece books its own proceeds share with an unknown basis.

Rate limits, per client IP (keyed by the trailing `X-Forwarded-For` hop behind a trusted proxy, else the socket): 12 wallet scans/min, 60 on-chain/price calls/min; configure via `RATE_LIMIT_SCAN_PER_MIN` / `RATE_LIMIT_RPC_PER_MIN`. Token endpoints and `/accruals` accept both `mint` and `symbol` — when both are passed, `mint` wins. `/onchain` verdicts are `ok | planes-disagree` — the verdict compares the issuer plan (`api`, evaluated at the requested date) against `onChainEffective` (the mint's current `active` multiplier with an already-activated `pending` applied); the raw `active` value may legitimately differ from `api` when a pending rebase sits in between. `/crosscheck` verdicts are the five values listed above.

### Webhooks

The API is read-only; deliveries are initiated by an operator or cron through the CLI, not by the server. Subscriptions live in `data/webhooks.json` (`{id, url, symbols, secret, createdAt, active}`), where `symbols` is `"*"` or an array of registry symbols and/or mints — the CLI resolves registry symbols to mints before matching (canonical events carry only the mint); an identifier found in neither is reported in the warnings. Deliver with `node scripts/webhook-deliver.mjs --events data/events.json` (or stdin); exit codes 0/1/2 mean no-failures / some deliveries failed / usage-or-input error. Payloads are POSTed with `X-Lotwise-Event`, a deterministic `X-Lotwise-Delivery` id (dedupe across reruns on the receiver side) and `X-Lotwise-Signature: sha256=<HMAC-SHA256 of the exact body>`; retries back off 1s → 4s. Subscription URLs must be public: the SSRF denylist refuses private, loopback, CGNAT and metadata addresses at the literal level (DNS names are not resolved — testing against a public DNS name that maps to loopback is possible and is an accepted operator-level risk).

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
- `cli/` the serve flag grammar: `--flag value` and `--flag=value` forms, malformed values rejected before any I/O, and the host is resolved and the port probed before boot starts spending RPC quota.

Live on-chain findings observed during development: SPACEX multiplier `1` → `5` effective 2026-06-10, OPENAI `1` → `1.4861347` effective 2026-07-17. Tessera tokens have no rebase mechanism; their multiplier is `1`, and the API says so plainly.

## Testing

```sh
node --test test/*.test.mjs
```

817 tests, all green (plain `node:test`; no mocks for the core paths — the lot engine, timeline and reconcile are tested as pure functions on real-shaped data).

## Status

Built for the Colosseum Crypto World's Fair hackathon (Solana track), September 14 to October 12, 2026.

Lotwise is read-only infrastructure. It writes nothing to mainnet, ships no SPL programs of its own, introduces no new token and no protocol for users to opt into. The only mutable state is local data files under `data/`, which are rebuilt from chain and issuer APIs on boot.

## License

MIT — see [LICENSE](LICENSE).
