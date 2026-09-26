# Webhooks

The API is read-only; deliveries are initiated by an operator or cron through the CLI,
not by the server. This file carries the full contract; the README keeps the summary.

## Subscriptions

Subscriptions live in `data/webhooks.json`:

```json
{"id": "...", "url": "https://example/hook", "symbols": "*", "secret": "...",
 "createdAt": "...", "active": true}
```

`symbols` is `"*"` (everything) or an array of registry symbols and/or mints — the CLI
resolves registry symbols to mints before matching (canonical events carry only the
mint); an identifier found in neither is reported in the warnings.

## Delivering

```sh
node scripts/webhook-deliver.mjs --events data/events.json   # or pipe to stdin
```

Exit codes: `0` no failures / `1` some deliveries failed / `2` usage-or-input error.

## The delivery request

- `POST` with headers:
  - `X-Lotwise-Event` — the event type;
  - `X-Lotwise-Delivery` — a **deterministic** delivery id (dedupe across reruns on
    the receiver side);
  - `X-Lotwise-Signature: sha256=<HMAC-SHA256 of the exact body>` — verify with the
    subscription's `secret` over the raw body bytes.
- Retries back off 1s → 4s.

## SSRF policy

Subscription URLs must be public: the denylist refuses private, loopback, CGNAT and
metadata addresses at the **literal** level. DNS names are not resolved — testing
against a public DNS name that maps to loopback is possible and is an accepted
operator-level risk.
