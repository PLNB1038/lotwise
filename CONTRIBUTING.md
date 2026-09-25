# Contributing

Lotwise is a small, deliberately boring codebase: Node.js 24+, ESM, **zero runtime
dependencies** (the standard library only). Keep it that way — a data-integrity tool
should be auditable by reading it, not by auditing a dependency tree.

## Ground rules

- **No new runtime dependencies.** If a problem seems to need one, bring it up in an
  issue first; almost everything here is achievable with `node:*` modules.
- **Fail closed.** When a source is unavailable or malformed, the honest outcome is
  an explicit error or a flagged skip — never a fabricated or defaulted value. Read
  the module headers in `src/` before changing error paths; the comments record why
  each guard exists.
- **Exact numbers.** Quantities are integers (BigInt) and decimal strings, never
  floats. Dates go through the strict ISO-8601 parser in `src/schema/isodate.mjs`.
- **English everywhere** — comments, messages, test names, commit messages.

## Development

```sh
node --test test/*.test.mjs   # full suite, ~7s, fully offline
node scripts/serve.mjs        # local demo on http://127.0.0.1:8787/
```

The suite is hermetic: no network, no fixture servers, no mocks on the core paths —
the lot engine, timeline and reconcile are tested as pure functions on real-shaped
data. CI runs the same command on every push.

## Adding a token

The registry is `data/tokens.json` — one entry per tokenized equity, validated on every
load by `validateRegistryEntry` (`src/registry/registry.mjs`):

- `mint` — the on-chain mint, base58. This is the token's identity; it must exist on
  mainnet (a well-formed but nonexistent mint passes the loader and fails loudly at scan
  time — verify the mint before submitting).
- `symbol`, `name` — non-empty strings; the symbol is what subscriptions and the page address.
- `issuer` — one of `backed | backpack | prestocks | tessera`: the family decides the
  decimals contract and which boot path reads the token.
- `decimals` — `null` until verified; `node scripts/enrich-decimals.mjs` fills it from the
  Jupiter Price API and refuses to write garbage.

After editing, run the suite, then `node scripts/check-issuers.mjs` — a read-only
reconciliation of the registry against the issuers' own sources (it reports divergence,
it never edits the file).

## Pull requests

1. Write the failing test first. Every behavioral change in this repo landed as
   red → green; the test names tell the story of what went wrong before the fix.
2. Keep diffs minimal and explain the *constraint*, not the change — a comment that
   says why a guard exists is worth more here than the code it sits on.
3. One logical change per PR, and make the suite green before requesting review.

## Reporting bugs

Include the endpoint or command, the exact input, and what came back verbatim —
output that looks wrong is usually the engine being honest about a source that lied,
and the distinction matters.
