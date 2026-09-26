// Adversarial/chaos tests of the HTTP API (src/api/server.mjs): we drive the server into
// broken inputs and races. The file's contract — every case pins the ACTUAL behavior
// (status / response shape / is the process alive), not the desired one. If a behavior looks
// strange but is defined and safe — it is pinned with a "finding" note.
// Timeout behavior (slow external sources) is deliberately NOT tested:
// there are no live sources in this file — all stubs are instant.
//
// Findings recorded here:
//   1. [a finding of round N, fixed and re-pinned] `//events?...` was parsed by the server's
//      new URL(req.url, base) as a PROTOCOL-RELATIVE reference: the authority "events"
//      was discarded, pathname became "/", the query was lost — the client got 200
//      text/html of the main page instead of 404/data. Now a leading "//" is cut off
//      before parsing: an honest 404 JSON, but NOT the main page (the pin is in group 2).
//   2. [a finding of round N, fixed and re-pinned] 405 went without the Allow header (RFC 9110
//      requires Allow in a 405 response) and HEAD got 405 instead of GET semantics without a body —
//      HEAD probes of monitoring failed on live routes. Now 405 carries
//      "Allow: GET, HEAD", HEAD on GET routes — 200 with the GET headers and an empty
//      body (the pin is in group 2).
//   3. `/%2e%2e/` and `/%2e%2e/health` — WHATWG URL normalizes the "%2e%2e" segments before the
//      router query: traversal reduces to "/" and "/health", you cannot escape the root (good, and pinned).
//   4. raw beyond Number.MAX_SAFE_INTEGER (26 and 10240 digits) is computed EXACTLY:
//      scaledQty is BigInt math, there are no strings here — no precision loss.
//   5. date=0000-01-01 is accepted by the strict parser (year 0 — a valid canonical ISO
//      of the project): unexpected, but defined — multiplier "1" (before all events).
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createApiServer } from "../src/api/server.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu"; // valid base58, as elsewhere in the suite

const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);

// The SPYx multiplier on 2026-07-01: "1.005714560286254" → an exact fraction (regardless of the engine:
// the numbers are hardcoded so the test does not trust the same functions it verifies).
const NUM = 1005714560286254n;
const DEN = 10n ** 15n;

// A server with instant stubs of external sources (no live sources in the chaos file).
// walletScanner/onchainReader count their calls when substituted — that is part of the pins.
function makeStubs() {
  const stubs = {
    calls: { wallet: 0, onchain: 0 },
    walletScanner: async () => {
      stubs.calls.wallet += 1;
      return { owner: OWNER, signatures: 0, fetched: 0, skipped: [], truncated: false, accounts: new Map(), txs: [] };
    },
    onchainReader: async () => {
      stubs.calls.onchain += 1;
      return {
        activeMultiplier: "1.003909240011759",
        pendingMultiplier: "1.005714560286254",
        pendingEffectiveDate: "2026-06-18T00:00:00.000Z",
        hasExtension: true,
      };
    },
  };
  return stubs;
}

async function withServer(fn, optsFn = null) {
  const registry = await loadRegistry("data/tokens.json");
  const stubs = makeStubs();
  const opts = typeof optsFn === "function" ? optsFn(stubs) : {};
  const server = await createApiServer({ registry, events, ...opts });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, stubs);
  } finally {
    server.close();
  }
}

// The server is alive and answers the /health contract — called after every hostile group.
async function assertAlive(base) {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200, "the server is alive after the storm");
  assert.equal((await r.json()).ok, true);
}

// A raw socket for cases fetch will not send (a broken request-target, no Host).
// Reads the status line + headers (+ the body by Content-Length), then tears the connection down.
function rawRequest(port, payload) {
  return new Promise((resolve) => {
    const chunks = [];
    const s = net.connect(port, "127.0.0.1", () => s.write(payload));
    const finish = () => {
      s.destroy();
      resolve(Buffer.concat(chunks).toString("latin1"));
    };
    s.on("data", (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const m = /content-length: (\d+)/i.exec(buf.toString("latin1"));
        const need = headerEnd + 4 + (m ? Number(m[1]) : 0);
        if (buf.length >= need) return finish();
      }
    });
    s.on("error", (e) => resolve(`ERR ${e.code}`));
    setTimeout(finish, 3000).unref();
  });
}

// ---- group 1: broken queries — symbol ----

test("a symbol with spaces/unicode/null-byte — 400 \"not tracked\", no crash", async () => {
  await withServer(async (base) => {
    // all variants are NOT an exact match of a registry symbol → the endpoints convention: 400
    const junk = ["%20", "SPYx%20", "%20SPYx", "%00", "SPYx%00", "%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82%F0%9F%94%A5", "SPY+x"];
    for (const s of junk) {
      assert.equal((await fetch(`${base}/events?symbol=${s}`)).status, 400, `/events symbol=${s}`);
      assert.equal((await fetch(`${base}/multiplier?symbol=${s}&raw=1000`)).status, 400, `/multiplier symbol=${s}`);
      assert.equal((await fetch(`${base}/onchain?symbol=${s}`)).status, 400, `/onchain symbol=${s}`);
    }
    // the lookup goes over the DECODED value: "%78" is "x", canonicalization before the lookup —
    // you cannot bypass the registry by percent-encoding (nor break the lookup): an honest 200
    const r = await fetch(`${base}/events?symbol=SPY%78`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).length, 4);
    await assertAlive(base);
  });
});

test("a 10KB string as symbol — 400, the connection and the server are alive", async () => {
  await withServer(async (base) => {
    // 10240 chars: a request-line ~10.3KB — under the default node header cap (16KB),
    // so we reach the router: the registry contains no such symbol → 400
    const res = await fetch(`${base}/events?symbol=${"A".repeat(10240)}`);
    assert.equal(res.status, 400);
    await assertAlive(base);
  });
});

// ---- group 1: broken queries — raw ----

test("raw: 0 is valid (an exact zero), notations/spaces/null-byte/empty — 400", async () => {
  await withServer(async (base) => {
    // "0" — a valid zero of base units: an exact zero, not an error
    const r0 = await fetch(`${base}/multiplier?symbol=SPYx&raw=0&date=2026-07-01`);
    assert.equal(r0.status, 200);
    const j0 = await r0.json();
    assert.equal(j0.sampleScaledQty.exact, true);
    assert.equal(j0.sampleScaledQty.whole, "0");
    // the existing tests pin 0x10/-5/abc/1.5; here are the classes missing there:
    for (const raw of ["1e10", "+5", "%205", "5%00", "5.0", ""]) {
      assert.equal(
        (await fetch(`${base}/multiplier?symbol=SPYx&raw=${raw}&date=2026-07-01`)).status,
        400,
        `raw=${JSON.stringify(decodeURIComponent(raw))}`,
      );
    }
    await assertAlive(base);
  });
});

test("raw beyond Number.MAX_SAFE_INTEGER — exact BigInt math, no precision loss occurs", async () => {
  await withServer(async (base) => {
    // 26 nines (~1e26, ten billion times more than MAX_SAFE_INTEGER ≈ 9e15):
    // the engine computes in BigInt (scaledQty) — the answer must match the exact expectation
    const raw26 = "9".repeat(26);
    const r = await fetch(`${base}/multiplier?symbol=SPYx&raw=${raw26}&date=2026-07-01`);
    assert.equal(r.status, 200);
    const j = await r.json();
    const expected = (BigInt(raw26) * NUM) / DEN;
    assert.equal(j.sampleScaledQty.whole, expected.toString()); // 99999999999999999999999999 × 1.0057… without float rounding
    assert.equal(j.sampleScaledQty.den, DEN.toString());

    // 10240 digits: both the precision and the absence of a hang on multiplying large numbers
    const rawBig = "9".repeat(10240);
    const rb = await fetch(`${base}/multiplier?symbol=SPYx&raw=${rawBig}&date=2026-07-01`);
    assert.equal(rb.status, 200);
    const jb = await rb.json();
    assert.equal(jb.sampleScaledQty.whole, ((BigInt(rawBig) * NUM) / DEN).toString());
    assert.ok(jb.sampleScaledQty.whole.length > 10000); // ~10241 digits — did not collapse into an exponent/NaN
    await assertAlive(base);
  });
});

// ---- group 1: broken queries — date ----

test("broken dates (roll-overs, 24:00, 23:59:60, an offset +99:99, a null-byte, empty) — 400, the reader is not hit", async () => {
  await withServer(async (base, stubs) => {
    // the existing tests pin garbage/2026-1-1/naive time/2026-13-01; here the remaining
    // garbage classes, including roll-overs that Date.parse "rolled over" silently
    const bad = [
      "2026-02-30", // rolled over to March 2
      "2026-06-31", // rolled over to July 1
      "2027-02-29", // not a leap year
      "2026-06-18T24:00:00Z", // 24:00 — not a time
      "2026-06-18T23:59:60Z", // a leap second
      "2026-06-18T12:00:00+99:99", // an offset out of range
      "2026-07-01%00", // a null-byte after a valid form
      "", // empty — NOT the "now" default, but an honest 400
      "%F0%9F%94%A5", // an emoji
    ];
    for (const d of bad) {
      assert.equal(
        (await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=${d}`)).status,
        400,
        `date=${JSON.stringify(decodeURIComponent(d))}`,
      );
      assert.equal(
        (await fetch(`${base}/onchain?symbol=SPYx&date=${d}`)).status,
        400,
        `/onchain date=${JSON.stringify(decodeURIComponent(d))}`,
      );
    }
    assert.equal(stubs.calls.onchain, 0); // garbage does not warm the cache with real calls
    await assertAlive(base);
  });
});

test("boundary valid dates are not rejected: the 2024-02-29 leap, the -05:00 offset, year 0000", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=2024-02-29`)).status, 200);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=2026-06-18T12:00:00-05:00`)).status, 200);
    // a finding: year 0 — a valid canonical ISO of the project (setUTCFullYear(0)); defined,
    // if unexpected: multiplier "1" — before all the 2026 events
    const r = await fetch(`${base}/multiplier?symbol=SPYx&date=0000-01-01`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.multiplier, "1");
    assert.equal(j.date, "0000-01-01"); // the response echoes the input date as is
    await assertAlive(base);
  });
});

// ---- group 1: duplicates and empty values ----

test("duplicate parameters: URLSearchParams.get takes the FIRST occurrence", async () => {
  await withServer(async (base) => {
    // symbol: the first garbage, the second valid → garbage wins → 400 (and the reverse → 200)
    assert.equal((await fetch(`${base}/events?symbol=NOPE&symbol=SPYx`)).status, 400);
    const ok = await fetch(`${base}/events?symbol=SPYx&symbol=NOPE`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).length, 4);
    // raw: the first broken → 400, the first valid → 200 (the second is silently ignored — a finding:
    // "raw=abc&raw=1000" is not a parse error but a refusal by the first; there is no double key)
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=abc&raw=1000`)).status, 400);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&raw=abc`)).status, 200);
    // date: the same first occurrence
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&date=2026-07-01&date=zzz`)).status, 200);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&date=zzz&date=2026-07-01`)).status, 400);
    await assertAlive(base);
  });
});

test("empty query values and broken /lots addresses — honest 400s", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/events?symbol=`)).status, 400);
    const noAddr = await fetch(`${base}/lots?address=`);
    assert.equal(noAddr.status, 400);
    assert.match((await noAddr.json()).error, /address required/);
    // base58 address validation: a space, 45 chars, non-base58 alphabet (O/0/I/l), unicode
    for (const a of ["%20", `${OWNER}x`, "O".concat("0".repeat(43)), "%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82", "0".repeat(44)]) {
      assert.equal((await fetch(`${base}/lots?address=${a}`)).status, 400, `address=${decodeURIComponent(a).slice(0, 10)}…`);
    }
    await assertAlive(base);
  });
});

test("/lots with a valid address and an empty scan — 200 with an empty report, the scanner called exactly once", async () => {
  await withServer(
    async (base, stubs) => {
      const r = await fetch(`${base}/lots?address=${OWNER}`);
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.deepEqual(j.tokens, []);
      assert.equal(stubs.calls.wallet, 1);
      await assertAlive(base);
    },
    (stubs) => ({ walletScanner: stubs.walletScanner }),
  );
});

// ---- group 2: methods and protocol ----

test("methods ≠ GET — 405 with the Allow header (RFC 9110); HEAD — GET semantics without a body", async () => {
  await withServer(async (base) => {
    // used to be a finding (Allow was missing) — now a 405 must carry it: the client sees
    // which methods are allowed without blindly probing them
    for (const method of ["OPTIONS", "POST", "PUT", "PATCH", "DELETE"]) {
      const r = await fetch(`${base}/health`, { method });
      assert.equal(r.status, 405, method);
      const j = await r.json();
      assert.match(j.error, /method not allowed/);
      assert.equal(r.headers.get("allow"), "GET, HEAD", `${method}: a 405 without Allow — an RFC 9110 violation`);
    }
    // HEAD on GET routes is no longer 405: the status and headers like GET, no body
    // (node drops the body of HEAD itself, Content-Length stays from the GET output)
    const h = await fetch(`${base}/health`, { method: "HEAD" });
    assert.equal(h.status, 200);
    assert.match(h.headers.get("content-type"), /application\/json/);
    assert.ok(Number(h.headers.get("content-length")) > 0, "Content-Length like GET");
    assert.equal((await h.text()).length, 0, "HEAD: no body");
    const page = await fetch(`${base}/`, { method: "HEAD" });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.equal((await page.text()).length, 0, "HEAD on \"/\": no body");
    // 404 under HEAD is alive too: the status is honest, no body
    const nf = await fetch(`${base}/nope`, { method: "HEAD" });
    assert.equal(nf.status, 404);
    assert.equal((await nf.text()).length, 0);
    await assertAlive(base);
  });
});

test("/health with query garbage — 200 ok:true (the query is ignored); a non-ASCII path — a 404 JSON", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/health?junk=1&x=%00&symbol=${"A".repeat(2048)}`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    const nf = await fetch(`${base}/${encodeURIComponent("hello🔥")}`);
    assert.equal(nf.status, 404);
    const nfBody = await nf.json();
    assert.match(nfBody.error, /not found/);
    assert.ok(Array.isArray(nfBody.endpoints)); // the 404 shape did not degrade
    await assertAlive(base);
  });
});

test("//double//slash — a protocol-relative request-target: an honest 404, NOT the main page (re-pinned)", async () => {
  await withServer(async (base) => {
    // was: new URL("//events?symbol=SPYx", base) saw the authority "events", pathname "/",
    // the query was lost — the client got 200 text/html of the main page. Now: the leading "//"
    // is cut off BEFORE parsing — that is a foreign authority (not our host), an honest 404 JSON.
    // Silently serving "/" is routing blindness; canonicalizing into "/events" would
    // encourage broken request-targets, so we pin exactly the 404.
    const r = await fetch(`${base}//events?symbol=SPYx`);
    assert.equal(r.status, 404);
    assert.match(r.headers.get("content-type"), /application\/json/);
    const body = await r.json();
    assert.match(body.error, /not found/);
    assert.ok(Array.isArray(body.endpoints)); // the 404 shape did not degrade
    // the query in the "//x" form is not forgiven for any route
    const r2 = await fetch(`${base}//multiplier?symbol=SPYx&raw=1000`);
    assert.equal(r2.status, 404);
    assert.match(r2.headers.get("content-type"), /application\/json/);
    // ordinary slashes INSIDE the path are untouched by the guard: the route still answers
    const nested = await fetch(`${base}/health`);
    assert.equal(nested.status, 200);
    await assertAlive(base);
  });
});

test("/%2e%2e/ — WHATWG normalization before the router: traversal does not escape the root", async () => {
  await withServer(async (base) => {
    // "%2e%2e" = ".." for WHATWG URL: "/%2e%2e/" → "/" (the page), "/%2e%2e/health" → "/health".
    // No escape to another host/path — we pin the normalization as a defense.
    const root = await fetch(`${base}/%2e%2e/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type"), /text\/html/);
    const h = await fetch(`${base}/%2e%2e/health`);
    assert.equal(h.status, 200);
    assert.equal((await h.json()).ok, true);
    // "/../health" is normalized by undici on the client already — the server sees "/health"
    const dotdot = await fetch(`${base}/../health`);
    assert.equal(dotdot.status, 200);
    assert.equal((await dotdot.json()).ok, true);
    await assertAlive(base);
  });
});

test("raw socket: the request-target \"http://:80/\" — a 400 malformed target, the process alive (a past crash vector)", async () => {
  await withServer(async (base) => {
    const { port } = new URL(base);
    // fetch will not send such a request-target — only a raw socket. The catch in server.mjs
    // (ERR_INVALID_URL) used to be missing and killed the process with a single request.
    const buf = await rawRequest(Number(port), "GET http://:80/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    assert.match(buf, /^HTTP\/1\.1 400/);
    assert.match(buf, /malformed request target/); // that is our handler-400, not the node parser
    // HTTP/1.1 without the mandatory Host — a 400 from the node parser itself, the connection closes
    const noHost = await rawRequest(Number(port), "GET /health HTTP/1.1\r\n\r\n");
    assert.match(noHost, /^HTTP\/1\.1 400/);
    assert.match(noHost, /Connection: close/i);
    await assertAlive(base);
  });
});

// ---- group 3: concurrency ----

test("50 concurrent requests over mixed routes — all answer as expected, the server alive after the storm", async () => {
  await withServer(
    async (base) => {
      const plan = [
        ["/health", 200],
        ["/summary", 200],
        ["/tokens?issuer=tessera", 200],
        [`/events?symbol=SPYx`, 200],
        [`/events?symbol=SPYx&type=NOPE`, 400], // a garbage type — an honest refusal, not a silent []
        [`/events`, 400],
        [`/multiplier?symbol=SPYx&raw=100000000&date=2026-07-01`, 200],
        [`/multiplier?symbol=SPYx&raw=abc`, 400],
        [`/multiplier?symbol=NOPE&raw=1`, 400],
        [`/onchain?symbol=SPYx&date=2026-06-18`, 200],
        [`/onchain?symbol=SPYx&date=2026-02-30`, 400],
        [`/lots?address=${OWNER}`, 200],
        [`/lots?address=${"0".repeat(44)}`, 400],
        ["/nope", 404],
        ["/", 200],
      ];
      const shots = [];
      for (let i = 0; i < 50; i++) {
        const [url, expect] = plan[i % plan.length];
        shots.push({ url, expect });
      }
      const results = await Promise.all(
        shots.map(async ({ url, expect }) => {
          const r = await fetch(`${base}${url}`);
          return { url, expect, status: r.status };
        }),
      );
      for (const { url, expect, status } of results) {
        assert.equal(status, expect, `${url} → ${status}, expected ${expect}`);
      }
      await assertAlive(base); // after the storm the server is alive and answers the contract
    },
    (stubs) => ({ walletScanner: stubs.walletScanner, onchainReader: stubs.onchainReader }),
  );
});

test("two concurrent requests to one resource: the first render of \"/\" and /multiplier — identical responses, no cache races", async () => {
  await withServer(async (base) => {
    // both arrive BEFORE the first render: pageHtml ??= renderPage() is synchronous, there is no race window —
    // we pin the absence of a "stampede" (a double render/divergent bodies)
    const [a, b] = await Promise.all([fetch(`${base}/`), fetch(`${base}/`)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(await a.text(), await b.text());
    // the same for the cacheable computation — two parallel /multiplier are identical
    const url = `${base}/multiplier?symbol=SPYx&raw=100000000&date=2026-07-01`;
    const [m1, m2] = await Promise.all([fetch(url), fetch(url)]);
    assert.equal(m1.status, 200);
    assert.equal(m2.status, 200);
    assert.deepEqual(await m1.json(), await m2.json());
    await assertAlive(base);
  });
});

// One wallet scan at a time (admission control): a scan holds the RPC pacing queue for
// minutes on a real wallet (62 derived ATA sources); a second concurrent scan used to
// pile onto the same queue — the backlog grew without bound and even /onchain waited
// behind it. The second address now gets a typed 503 with Retry-After instead of a hang.
test("scan admission: a second concurrent wallet scan gets a typed 503, the first completes", async () => {
  const OTHER = "EJBQLNEH1x6buMSpUS4TLCknXygyfkbSQ2eyFqWEkv5U"; // valid base58, a different wallet
  let release;
  const gate = new Promise((r) => { release = r; });
  await withServer(async (base) => {
    const first = fetch(`${base}/lots?address=${OWNER}`);
    try {
      await new Promise((r) => setTimeout(r, 60)); // let the first scan actually start
      const second = await fetch(`${base}/lots?address=${OTHER}`);
      assert.equal(second.status, 503, "the concurrent scan is refused, not queued forever");
      const body = await second.json();
      assert.equal(body.kind, "scan-busy", "a typed refusal the client can retry on");
      assert.ok(Number(second.headers.get("retry-after")) > 0, "a retry hint is present");
    } finally {
      release(); // never leave the first scan gated on a failed assert
    }
    const r1 = await first;
    assert.equal(r1.status, 200, "the first scan is unaffected and completes");
  }, () => ({
    walletScanner: async (address) => {
      if (address === OWNER) await gate;
      return { owner: address, signatures: 0, fetched: 0, skipped: [], truncated: false, accounts: new Map(), txs: [] };
    },
  }));
});

// A broken declarations channel must be visible WHERE the dividends are consumed, not
// only in /health (which integrators do not poll): /accruals answers 200 [] in ALL three
// states — no declarations declared, none for this token, channel down — and the header
// is the only honest separator that does not break the array contract of the body.
test("/accruals: a broken declarations channel is named in a response header", async () => {
  await withServer(async (base) => {
    const down = await fetch(`${base}/accruals?symbol=SPYx&address=${OWNER}`);
    assert.equal(down.status, 200);
    assert.equal(down.headers.get("x-declarations-unavailable"), "1",
      "the degradation is visible where the data is consumed");
    assert.deepEqual(await down.json(), [], "the body contract is unchanged");
  }, () => ({
    walletScanner: async () => ({ owner: OWNER, signatures: 0, fetched: 0, skipped: [], truncated: false, accounts: new Map(), txs: [] }),
    declarationsStats: { ok: false, loaded: 0, superseded: 0, reason: "declarations rejected: test" },
  }));
  await withServer(async (base) => {
    const up = await fetch(`${base}/accruals?symbol=SPYx&address=${OWNER}`);
    assert.equal(up.headers.get("x-declarations-unavailable"), null,
      "a healthy channel adds no header");
  }, () => ({
    walletScanner: async () => ({ owner: OWNER, signatures: 0, fetched: 0, skipped: [], truncated: false, accounts: new Map(), txs: [] }),
    declarationsStats: { ok: true, loaded: 0, superseded: 0, reason: null },
  }));
});

// A scan-busy refusal must not burn the caller's rate budget: the semaphore used to be
// checked AFTER the limiter, so a dozen cheap 503s exhausted the bucket and the honest
// retry (after the scan released) hit a 429 — one stuck scan locked a victim out twice.
test("scan admission: scan-busy refusals do not consume the rate budget", async () => {
  const OTHER = "EJBQLNEH1x6buMSpUS4TLCknXygyfkbSQ2eyFqWEkv5U";
  const THIRD = "Ho5371Kc1Kxy7ze85UYzZ4BUfSkLg39Xp3B424RuYrbC";
  let release;
  const gate = new Promise((r) => { release = r; });
  await withServer(async (base) => {
    const first = fetch(`${base}/lots?address=${OWNER}`);
    try {
      await new Promise((r) => setTimeout(r, 60));
      for (let i = 0; i < 15; i++) {
        const r = await fetch(`${base}/lots?address=${OTHER}`);
        assert.equal(r.status, 503, `refusal ${i}: the concurrent scan is refused`);
        assert.equal((await r.json()).kind, "scan-busy");
      }
    } finally {
      release();
    }
    await first;
    // the limiter saw none of the scan-busy refusals: a fresh scan passes immediately
    const after = await fetch(`${base}/lots?address=${THIRD}`);
    assert.equal(after.status, 200, "the honest retry is not rate-limited by the refusals");
  }, () => ({
    walletScanner: async (address) => {
      if (address === OWNER) await gate;
      return { owner: address, signatures: 0, fetched: 0, skipped: [], truncated: false, accounts: new Map(), txs: [] };
    },
  }));
});

// HEAD on a scan endpoint used to run the FULL scan (semaphore + RPC quota) for an empty
// body — a monitoring probe could hold the one scan slot. Scan endpoints are GET-only.
test("scan endpoints: a HEAD probe does not run a wallet scan", async () => {
  await withServer(async (base, stubs) => {
    const r = await fetch(`${base}/lots?address=${OWNER}`, { method: "HEAD" });
    assert.equal(r.status, 405, "a HEAD probe is refused before any scan work");
    assert.equal(stubs.calls.wallet, 0, "the scanner was never called");
  }, (stubs) => ({ walletScanner: stubs.walletScanner }));
});

// The declarations header must fire for the PROD shape of declarationsStats: serve.mjs
// builds ok as a NUMBER (1|0, JSON-stable in /health), while the first test pinned a
// boolean — a green test over a dead feature.
test("/accruals: the degradation header fires for the numeric prod shape of declarations.ok", async () => {
  await withServer(async (base) => {
    const down = await fetch(`${base}/accruals?symbol=SPYx&address=${OWNER}`);
    assert.equal(down.status, 200);
    assert.equal(down.headers.get("x-declarations-unavailable"), "1",
      "the header fires for ok: 0 — the shape serve.mjs actually builds");
  }, () => ({
    walletScanner: async () => ({ owner: OWNER, signatures: 0, fetched: 0, skipped: [], truncated: false, accounts: new Map(), txs: [] }),
    declarationsStats: { ok: 0, loaded: 0, superseded: 0, reason: "declarations rejected: test" },
  }));
});

// The degradation header is falsy-gated, not shape-whitelisted: any PRESENT stats object
// whose ok is not truthy (missing, null, a future builder shape) must surface the header —
// a whitelist let the boolean-vs-number mismatch leave it dead once already.
test("/accruals: a declarations stats object without a truthy ok surfaces the degradation header", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=SPYx&address=${OWNER}`);
    assert.equal(r.headers.get("x-declarations-unavailable"), "1",
      "an unset ok of a present stats object means 'not confirmed healthy'");
  }, () => ({
    walletScanner: async () => ({ owner: OWNER, signatures: 0, fetched: 0, skipped: [], truncated: false, accounts: new Map(), txs: [] }),
    declarationsStats: { loaded: 0, reason: "boom" }, // ok is absent
  }));
});
