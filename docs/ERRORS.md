# Errors and rate limits

Every response is JSON; decimal quantities are strings everywhere (including
`amountPerUnitRaw` in `/events`); `/events` rows are chronological. This file carries
the full response/error contract; the README keeps the summary. Nothing here
introduces behavior — every statement is pinned by the test suite.

## Error shape

Errors are `{"error": string, "kind"?: string}` — `kind` is the retry policy.

## Transient — back off and retry

- `rate-limit` — arrives in **two shapes**: our own `429` (body `kind: "rate-limit"`,
  header `Retry-After`) and an upstream RPC refusal relayed as `503` with the same
  kind but no `Retry-After`. Both count against the scan budget, so a blind retry
  loop only exhausts it faster; back off in both cases.
- `network` — the transport failed.
- `scan-busy` — one wallet scan runs server-wide at a time; a concurrent scan request
  answers `503` with this kind and `Retry-After: 30`. Retry, do not parallelize.
- `aborted` — the caller's own connection went away (the scan is stopped for them);
  nothing to retry, the client is gone.

## Not retryable — the upstream refused or sent garbage

The endpoint answers `503` without fabricating data:

- `rpc` — an RPC-level failure.
- `http` — an HTTP-level failure at the source.
- `parse` — a price source returned an unusable body.
- `malformed-source` — an RPC source returned a non-array response.

A few untyped internal checks reject with `"kind": null`.

## Client errors — `400`

The request itself is wrong — unknown symbol/mint/issuer/type, a rolled-over date, a
structurally invalid address — and will fail identically on every retry. Wallet scan
endpoints (`/lots`, `/accruals`) are GET-only: a `HEAD` probe answers `405` with
`Allow: GET` without running a scan.

## Rate limits

Per client IP (keyed by the trailing `X-Forwarded-For` hop behind a trusted proxy,
else the socket):

| bucket | endpoints | default |
|---|---|---|
| scan | `/lots`, `/accruals` | 12 requests/min |
| rpc | `/onchain`, `/crosscheck` | 60 requests/min |

Every attempt counts, including refusals. Configure via `RATE_LIMIT_SCAN_PER_MIN` /
`RATE_LIMIT_RPC_PER_MIN`. The scan bucket is checked after the one-scan semaphore: a
`scan-busy` refusal does not consume rate budget.
