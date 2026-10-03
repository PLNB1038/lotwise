// The fourth stat tile is a claim, not a counter: "cross-checked / issuer vs on-chain"
// among mono 20px numerals scanned as a broken counter. An honest number is not cheap —
// verdicts are computed per token against live price data, /health carries no tally — so
// the tile keeps its card but drops the numeral face: a stat-note modifier renders the
// word at caption size, and the row scans as numbers plus a note.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../src/ui/page.mjs";

test("stats: the cross-checked tile is marked as a note, not a counter", () => {
  const html = renderPage();
  assert.match(html, /class="stat stat-note"><b>cross-checked<\/b><i>issuer vs on-chain<\/i><\/div>/,
    "the qualitative tile carries the note modifier");
  assert.equal(html.split("stat stat-note").length - 1, 1,
    "exactly one tile is a note — the counters keep the numeral face");
});

test("stats: the note face is a real style, not a bare class", () => {
  const html = renderPage();
  assert.match(html, /\.stat-note b \{[^}]*font-family: inherit/,
    "the word must not render in the counter's mono face");
  assert.match(html, /\.stat-note b \{[^}]*font-size: 13px/,
    "caption size, not the 20px numeral face");
});
