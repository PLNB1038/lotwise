// The vitrine favicon (the branding batch of 24.09): an inline SVG data-URI in <head> — the judges
// see the "L" logo on the browser tab in the demo video; no new file/route needed.
// The mark's ingredients are the same as in assets/logo-mark.svg, but in the single color #58a6ff:
// a data-URI has no CSS context of the page, currentColor has nothing to inherit from, and
// a neutral ink (#e6edf0 / #1f2328) vanishes on a light or dark tab bar.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../src/ui/page.mjs";

test("vitrine: the favicon — the L mark in a single accent as an SVG data-URI inside <head>", () => {
  const html = renderPage();
  const m = html.match(/<link rel="icon"[^>]*href="data:image\/svg\+xml,([^"]+)"/);
  assert.ok(m, "a link rel=icon with an SVG data-URI is present");
  const svg = decodeURIComponent(m[1]);
  assert.match(svg, /<svg[^>]*viewBox="0 0 32 32"/, "the square grid of the mark");
  assert.match(svg, /rect[^>]+fill="#58a6ff"/, "the trunk/leg of the L visible on any tab bar");
  assert.match(svg, /<circle/, "the event dot in place");
  assert.ok(html.indexOf('<link rel="icon"') < html.indexOf("</head>"), "the link inside head");
});
