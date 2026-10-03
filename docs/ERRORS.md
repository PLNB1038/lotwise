# Errors and rate limits

Every response is JSON (the showcase page at `/` is HTML); decimal quantities
are strings everywhere (including
`amountPerUnitRaw` in `/events`); `/events` rows are chronological. This file carries
the full response/error contract; the README keeps the summary. Nothing here
introduces behavior — every statement is pinned by the test suite.

## Error shape

Errors are `{"error": string, "kind"?: string}` — `kind` is the retry policy.

Several responses carry documented extras:

- a `404` body adds `endpoints` — the list of routable paths, so a mistyped path is
  answerable without leaving the API;
- a `400` refusal for a token excluded from multiplier reporting (`/events`, `/onchain`,
  `/crosscheck`, `/accruals`) adds `excluded: true` and `excludedReason` — the reason
  from `error`, duplicated for programmatic consumers;
- the exclusion marks also ride on `200` responses: `/summary` rows add `excluded: true`
  and `excludedReason` for such a token; `/multiplier` for it answers `200` with the
  no-timeline default `multiplier: "1"`, `events: 0` and the same two fields — that `1`
  is a default, not a computation; `/lots` token rows add both fields plus
  `adjustedAvailable: false`. `false` is the only value the field ever carries; its
  absence means the adjusted values were computed.

## Transient — back off and retry

- `rate-limit` — arrives in **two shapes**: our own `429` (body `kind: "rate-limit"`,
  header `Retry-After`) and an upstream RPC refusal relayed as `503` with the same
  kind but no `Retry-After`. Both count against the scan budget, so a blind retry
  loop only exhausts it faster; back off in both cases.
- `network` — the transport failed.
- `scan-busy` — one wallet scan runs server-wide at a time; a concurrent scan request
  answers `503` with this kind and `Retry-After` (at least 30s; grows with the previous scan's wall time). Retry, do not parallelize.
- `aborted` — the caller's own connection went away (the scan is stopped for them);
  nothing to retry, the client is gone.
- `shutting-down` — the instance is stopping: the request entered after shutdown began,
  and the drain admits no new work (requests that entered before it keep their service).
  Back off and retry — the deployment brings the instance back.

## Not retryable — the refusal is stable

The endpoint answers `503` without fabricating data:

- `rpc` — an RPC-level failure.
- `http` — an HTTP-level failure at the source.
- `parse` — a source returned an unusable body: a price response, or a store event the
  endpoint refused to read (an unparseable dividend date, a malformed event record).
- `malformed-source` — an RPC source returned a non-array response.
- `not-configured` — this deployment lacks the component the endpoint needs (the on-chain
  reader, the wallet scanner, the price provider — on a `--demo` boot all three, since the
  demo serves a static snapshot). STABLE: it will not recover by retrying — boot without
  `--demo` (or wire the component) instead.

A few untyped internal checks reject with `"kind": null`.

## Client errors — `400`

The request itself is wrong — unknown symbol/mint/issuer/type, a rolled-over date, a
structurally invalid address — and will fail identically on every retry. Wallet scan
endpoints (`/lots`, `/accruals`) are GET-only: a `HEAD` probe answers `405` with
`Allow: GET` at any query — including a bare path with none — without running a scan,
and every other non-GET method is refused by the same route with the same `Allow: GET`
(discovery never advertises HEAD on these routes; other routes keep `Allow: GET, HEAD`).

## Before the handler

One refusal never reaches the JSON contract: a request whose request line and
headers together exceed node:http's 16 KB header cap — an oversized request
target, one long header, or many small ones — is answered by the transport
with a bare `431` and an empty body — no `error`/`kind` shape, nothing
to retry against, the endpoint never sees the request. Just below the cap the
app's own contract holds again (an oversized-but-fitting address is a `400`).

## Rate limits

Per client IP (keyed by the trailing `X-Forwarded-For` hop behind a trusted proxy,
else the socket):

| bucket | endpoints | default |
|---|---|---|
| scan | `/lots`, `/accruals` | 12 requests/min |
| rpc | `/onchain`, `/crosscheck` | 60 requests/min |

Every attempt counts, including refusals. Configure via `RATE_LIMIT_SCAN_PER_MIN` /
`RATE_LIMIT_RPC_PER_MIN`. The scan bucket is checked after the one-scan semaphore: a
`scan-busy` refusal does not consume rate budget. The client learns its budget from the
`429` + `Retry-After` response; rate-budget headers (`X-RateLimit-*`) are intentionally
not provided.
