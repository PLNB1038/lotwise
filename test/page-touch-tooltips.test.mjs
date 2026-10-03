// The explanations ride title attributes, which a hover reveals and a touch tap does
// not. The page now wires a delegated click handler: any [title] element opens its
// title as a small fixed bubble (role="tooltip", wired by aria-describedby); a second
// tap on the same element, a tap anywhere else, or Escape closes it. The native hover
// tooltip stays — the bubble is the touch/keyboard path, not a replacement.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../src/ui/page.mjs";
import vm from "node:vm";

test("page: the tap-tooltip wiring is in the render — delegated click, Escape close", () => {
  const script = renderPage().match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.match(script, /document\.addEventListener\('click'/,
    "the listener is delegated to the document — innerHTML re-renders keep working");
  assert.match(script, /addEventListener\('keydown'/);
  assert.match(script, /'Escape'/, "a keyboard user can dismiss the bubble");
  assert.match(script, /setAttribute\('role', 'tooltip'\)/);
  assert.match(script, /setAttribute\('aria-describedby'/,
    "the bubble is announced as the element's description");
  assert.match(script, /removeAttribute\('aria-describedby'/, "closing un-wires the description");
});

test("page: the bubble has a face — .tip-bubble styled, [title] gets the help cursor", () => {
  const html = renderPage();
  assert.match(html, /\.tip-bubble \{[^}]*position: fixed/,
    "a tap on a table cell also scrolls the page — the bubble must survive it");
  assert.match(html, /\[title\] \{ cursor: help; \}/,
    "a tappable tooltip needs an affordance hint");
});

// A real toggle needs a DOM; the vm stub grows just enough: the delegated listener is
// captured at load, createElement mints stub nodes, body.appendChild keeps them.
function runClient() {
  const els = new Map();
  const listeners = {};
  const created = [];
  const removed = [];
  const makeEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", className: "", style: {},
    getAttribute() { return null; }, scrollIntoView() {},
  });
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [],
      addEventListener: (type, fn) => { listeners[type] = fn; },
      createElement: () => {
        const node = {
          className: "", textContent: "", attrs: {}, style: {},
          offsetWidth: 140, offsetHeight: 32,
          getAttribute(n) { return this.attrs[n] ?? null; },
          setAttribute(n, v) { this.attrs[n] = String(v); },
          removeAttribute(n) { delete this.attrs[n]; },
          getBoundingClientRect() { return { left: 10, top: 100, width: 40, height: 20 }; },
          parentNode: { removeChild: (n) => { removed.push(n); } },
        };
        created.push(node);
        return node;
      },
      body: { appendChild() {} },
    },
    window: { innerWidth: 980, innerHeight: 640 },
    fetch: () => new Promise(() => {}), // the boot chains hang: the tooltip needs no network
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "script block is in place");
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb); // syntax as in the browser
  return { sb, listeners, created, removed };
}

// a [title] element as the delegated handler sees it: closest walks to itself
function titled(title) {
  return {
    attrs: { title },
    closest(sel) { return sel === "[title]" ? this : null; },
    getAttribute(n) { return this.attrs[n] ?? null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    removeAttribute(n) { delete this.attrs[n]; },
    getBoundingClientRect() { return { left: 10, top: 100, width: 40, height: 20 }; },
  };
}

test("tap-tooltip: a tap opens the title as a tooltip bubble wired by aria-describedby", () => {
  const { listeners, created } = runClient();
  const src = titled("expected 2.000% vs observed 2.005% — dividend: mismatch");
  listeners.click({ target: src });
  assert.equal(created.length, 1, "one bubble per tap");
  const bubble = created[0];
  assert.equal(bubble.className, "tip-bubble");
  assert.equal(bubble.attrs.role, "tooltip");
  assert.equal(bubble.textContent, src.attrs.title, "the same text the hover tooltip carried");
  assert.match(src.attrs["aria-describedby"], /^tip-/, "the source announces the bubble");
});

test("tap-tooltip: a second tap on the same element closes and un-wires it", () => {
  const { listeners, created, removed } = runClient();
  const src = titled("exact: 1.0032690125398187");
  listeners.click({ target: src });
  const bubble = created[0];
  listeners.click({ target: src });
  assert.ok(removed.includes(bubble), "the bubble is gone from the DOM");
  assert.ok(!("aria-describedby" in src.attrs), "the description is un-wired");
});

test("tap-tooltip: a tap anywhere else closes the open bubble", () => {
  const { listeners, created, removed } = runClient();
  const src = titled("scan gap details");
  listeners.click({ target: src });
  const bubble = created[0];
  listeners.click({ target: { closest: () => null } });
  assert.ok(removed.includes(bubble), "an outside tap closes");
  assert.ok(!("aria-describedby" in src.attrs));
});

test("tap-tooltip: a tap on another title element retargets, not stacks", () => {
  const { listeners, created, removed } = runClient();
  const a = titled("first");
  const b = titled("second");
  listeners.click({ target: a });
  const first = created[0];
  listeners.click({ target: b });
  assert.ok(removed.includes(first), "the old bubble is closed");
  assert.ok(!("aria-describedby" in a.attrs), "the old source is un-wired");
  assert.match(b.attrs["aria-describedby"], /^tip-/);
  assert.equal(created.length, 2, "one bubble open at a time");
});

test("tap-tooltip: an element with an empty title opens nothing", () => {
  const { listeners, created } = runClient();
  listeners.click({ target: titled("") });
  assert.equal(created.length, 0, "no empty bubble");
});

test("tap-tooltip: the bubble flips below near the top edge and clamps at the right edge", () => {
  const { listeners, created } = runClient();
  const src = titled("exact: 1.05");
  src.getBoundingClientRect = () => ({ left: 960, top: 5, width: 40, height: 20 });
  listeners.click({ target: src });
  const bubble = created[0];
  assert.equal(bubble.style.left, "832px", "clamped into the viewport");
  assert.equal(bubble.style.top, "31px", "no room above — flipped below");
});
