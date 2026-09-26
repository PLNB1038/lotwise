# API semantics: `/lots` and `/accruals`

The README's API table is a catalog; this file is the depth. It carries the full
semantics of the two wallet-facing endpoints — the same promises the table used
to hold in single-cell form, per endpoint, with examples. Every statement here
is a contract pinned by the test suite; nothing in this file introduces new
behavior. The general response and error contract (string decimals, `kind` as
the retry policy, rate limits) lives in the README and applies here too.

Both endpoints are synchronous: wallet scans walk full transaction history, and
an active wallet can take minutes.

---

## `/lots?address=`

Wallet report: FIFO lots with cost basis, raw vs adjusted balances, realized
P&L from USDC legs.

Response shape (truncated to the money-carrying fields; decimal quantities are
strings, unknown ones are `null` — never an invented number):

```json
{
  "owner": "…", "method": "fifo",
  "truncated": false,
  "complete": true,
  "moneyOnly": [
    {"signature": "5xT9…", "date": "2026-08-02T14:11:00.000Z",
     "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "amountRaw": "-30000"}
  ],
  "tokens": [
    {
      "symbol": "SPYx", "mint": "…", "decimals": 8,
      "rawBalance": "100571456", "netDeltaRaw": "100571456", "onchainNow": "100571456",
      "reconciles": true,
      "lots": [
        {"id": 1, "qtyRaw": "100000000", "acquiredDate": "…",
         "basisRaw": "512300000", "basisKnown": true}
      ],
      "realized": [
        {"date": "…", "qtyRaw": "50000000", "basisRaw": "256150000", "basisKnown": true,
         "proceedsRaw": "260000000", "proceedsKnown": true, "pnlRaw": "3850000"}
      ],
      "gaps": []
    }
  ]
}
```

### Unpriced money: `moneyOnly`

`moneyOnly` rows list USDC the pricing did not consume:

- a same-tx round-trip spread — alone, or mixed with a trade whose pricing was
  withdrawn;
- a multi-token swap's USDC fee;
- a plain transfer.

A row is a signed net per mint, deliberately outside lots/realized/gaps — the
USDC moved, but no lot can honestly claim it.

The pricing is also withdrawn when a tracked account is merely SEEN in the same
tx's balances with no balance change (a passive approval, an empty account):
whether it moved and returned is not recoverable from balances, so the trade
stays unpriced and the money a fact row — conservative by design.

### The economic result of the window

The report does not collapse itself into one number; the consumer assembles the
economic result of the window as:

> Σ `pnlRaw`
> \+ Σ `moneyOnly` nets
> − Σ `basisRaw` of disposals with `proceedsKnown: false` and `basisKnown: true`
> \+ Σ `proceedsRaw` of disposals with `proceedsKnown: true` and `basisKnown: false`
> (a priced sale of an unbased lot: money received, basis unknown)
> \+ Σ `gaps[].proceedsRaw` (the hole's own sale share — really received money)

### One scan at a time

A real scan holds the RPC queue for minutes; queuing a second one would starve
every other endpoint. One wallet scan runs at a time: a concurrent scan request
answers `503` with `kind: "scan-busy"` and `Retry-After`:

```json
{"error": "another wallet scan is in progress, retry shortly", "kind": "scan-busy"}
```

The busy check happens before the rate limiter, so a scan-busy refusal costs
the caller no rate budget, and the running scan is untouched.

### GET-only

`/lots` and `/accruals` are GET-only: a HEAD probe answers `405` (`Allow:
GET`) without running a scan.

### Queue priorities

Point reads (the boot journal, `/onchain`) are prioritized over the scan stream
inside the shared RPC pacing queue — the vitrine stays responsive while a scan
runs.

---

## `/accruals?symbol=&address=`

Dividend accruals of one token for one wallet. Each row:

```json
{"symbol": "SPYx", "effectiveDate": "2026-07-10", "amountPerUnitRaw": "1234",
 "totalRaw": "2468000", "lotsConsidered": 2}
```

and, when the window cannot answer honestly:

```json
{"symbol": "SPYx", "effectiveDate": "2026-07-10", "amountPerUnitRaw": "1234",
 "totalRaw": null, "lotsConsidered": 0, "baseIncomplete": true}
```

### The base is the position at the ex-date

The base is the position held **at the start of the ex-date** (its UTC
midnight — a buy during the ex-date itself does not qualify), replayed from the
scan window — a sale after the ex-date does not shrink the dividend.

### `baseIncomplete` and `totalRaw: null`

Rows flag `baseIncomplete` when:

1. a transaction cannot be ordered against the ex-date;
2. the scan has gaps;
3. the window was truncated;
4. the scan's net delta did not reconcile with the live chain.

A window that saw only disposals answers `totalRaw: null` — never a negative
number an integrator would subtract — and is flagged `baseIncomplete` too.

### Dividend identity

A dividend's identity is its calendar ex-day and per-unit amount — the same
dividend from two sources accrues once. Two declarations naming different
ex-days are two dividends — including two timezone skins of one instant (the
declared ex-day is the economic fact).

### The declarations channel

Accruals come from operator-supplied dividend declarations —
`data/declarations.json`, loaded at boot, one line per declaration:

```json
{"symbol": "SPYx", "exDate": "2026-07-10", "amountPerUnitRaw": "1234",
 "decimals": 8, "sourceUrl": "https://…"}
```

`amountPerUnitRaw` is per RAW unit — a per-share declaration must be divided by
the ex-date multiplier before submission. xStocks publishes no per-unit
amounts, so in the live feed today dividend rebases appear as multiplier
events.

The declarations channel is append-only: a corrected re-declaration would
double the income until resolved — the loader warns about same-amount
declarations within three days.

### Corrections: `supersedes`

To express a correction, do not re-declare — supersede: append a new line for
the same symbol carrying

```json
"supersedes": {"exDate": "...", "amountPerUnitRaw": "..."}
```

naming the replaced declaration by its identity (the canonical ex-day and the
per-unit amount as originally declared; the correction may carry a new ex-day,
a new amount, or both).

The replacement removes the superseded line's accrual — the corrected amount
accrues alone, `/health` shows `declarations.superseded`.

The reference is one level deep and must resolve: a missing target, a
correction of a correction, a self-reference, or two corrections on one target
refuse the whole file at load (`declarations.ok: 0`, the reason in the boot
log) — a half-applied correction would leave the stale amount accruing, which
is the doubling this field exists to prevent. Lines without the field accrue
exactly as before.

### When the channel is down

A `200 []` here is either "no dividends" or "the declarations channel is down"
— the separator is the response header `X-Declarations-Unavailable: 1`
(present only when the channel refused the file; the mirror lives in `/health`
`declarations.ok`).

### GET-only

Like `/lots`, this endpoint is GET-only (a HEAD probe answers `405` without a
scan).
