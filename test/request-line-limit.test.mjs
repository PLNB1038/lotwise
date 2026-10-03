// The request line has a hard transport boundary: node:http refuses a request target
// beyond its 16 KB header cap with a bare `431` and an empty, non-JSON body BEFORE any
// handler runs — the endpoint's `{"error", "kind"}` contract presupposes a request line
// the transport accepted at all (docs/ERRORS.md, "Before the handler"). Below the cap
// the app speaks its own contract: an oversized-but-fitting address is a typed 400.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApiServer } from "../src/api/server.mjs";

const ADDR = "R31Wa11et" + "a".repeat(34);

const rawGet = (port, path) => new Promise((resolve, reject) => {
  const req = http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  req.on("error", reject);
});

test("a request target beyond the transport's request-line limit is a bare 431 before any handler — not the app's JSON contract", async () => {
  const server = await createApiServer({ registry: [], walletScanner: async () => { throw new Error("must not run — the handler is never reached"); } });
  try {
    const { status, body } = await rawGet(server.address().port, `/lots?address=${"A".repeat(20000)}`);
    assert.equal(status, 431);
    assert.equal(body, "", "the transport answers empty — no error/kind shape, the handler never spoke");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("a long-but-fitting request target stays inside the app's contract — a typed 400, not a transport refusal", async () => {
  const server = await createApiServer({ registry: [], walletScanner: async () => { throw new Error("must not run"); } });
  try {
    const { status, body } = await rawGet(server.address().port, `/lots?address=${"A".repeat(14000)}`);
    assert.equal(status, 400);
    const parsed = JSON.parse(body); // the JSON contract holds below the transport cap
    assert.ok(typeof parsed.error === "string");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
