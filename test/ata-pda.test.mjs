// Dependency-free PDA/ATA derivation.
// Three pieces live in src/wallet/scan.mjs and each is verified here against an
// INDEPENDENT implementation pinned at proposal time (solders 0.29.0 — the Rust
// curve25519-dalek stack Solana itself uses):
//   1. base58 encode      — pinned on 32-byte vectors emitted by solders `Pubkey` Display,
//                           plus the classic public vectors ("hello world", 0x61, zeros).
//   2. ed25519 on-curve   — pinned on 15 verdicts from solders `Pubkey::is_on_curve`
//                           (base point 0x5866…66, identity, y=0, 6 random on-, 6 random off-).
//   3. ATA derivation     — pinned on 12 (owner, mint, program) -> (ATA, bump) triples for the
//                           REAL repo wallets (EJBQ, Ho — docs/DEMO_TOUR.md) and REAL registry
//                           mints (data/tokens.json), emitted by solders find_program_address.
// The repo test suite stays zero-dep and zero-network: the pins are constant strings.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  encodeBase58,
  isOnCurveEd25519,
  findProgramAddress,
  deriveAta,
  ASSOC_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAMS,
  isValidAddress,
} from "../src/wallet/scan.mjs";

const hex = (h) => Uint8Array.from(Buffer.from(h, "hex"));

// base58 (Bitcoin alphabet) decode used only by tests to rebuild seeds from pubkeys
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58ToBytes(s) {
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  let leadZeros = 0;
  while (s[leadZeros] === "1") leadZeros++;
  const body = [];
  while (n > 0n) { body.unshift(Number(n & 0xffn)); n >>= 8n; }
  return new Uint8Array([...new Array(leadZeros).fill(0), ...body]);
}

// ---------------------------------------------------------------- base58 encode
test("encodeBase58: public vectors (classic constants + solders-pinned 32-byte)", () => {
  assert.equal(encodeBase58(new TextEncoder().encode("hello world")), "StV1DL6CwTryKyV");
  assert.equal(encodeBase58(Uint8Array.of(0x61)), "2g");
  assert.equal(encodeBase58(Uint8Array.of(0, 0)), "11", "leading zero bytes are leading '1's");
  assert.equal(encodeBase58(new Uint8Array(32).fill(0xff)), "JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG");
  assert.equal(encodeBase58(hex("1cbe218b98b62d3921a376c36a3536246429d7f4219b303307683d11186bfce5")), "2wCZy4ecVjYhFx9Wr5tQCv1AfWXm3s2XWFsoGrd73Htg");
  assert.equal(encodeBase58(hex("50b2fdd3212de7ee8185b0b9a9cc459c3beaad72213303efc548a2ac42148588")), "6S1vBAHxJFUiLSXXMuDX5QroM7xcvH5nM4At58LTkgEb");
  assert.equal(encodeBase58(hex("e8e947b91f936ae22a335e11086dc3d5ce7c5f2860cc41d6f462e081a9ab2c3a")), "GgBuCkRrrVhzSiPtLHz7mJ2Kn8u67gL82a3J2PBNM8RX");
  assert.equal(encodeBase58(hex("002c4fc49630bfb0896bf10738320fe9f6525bacb1c2e5661b7fd0dc26ba7f85")), "1gBz8o6MiZhsGuCn5qePJ3HPxeHjgFgDQj3ZFb2JxnY", "one leading zero byte -> one leading '1'");
});

test("encodeBase58 round-trips the repo's decoder contract (isValidAddress)", () => {
  for (const addr of [
    "EJBQLNEH1x6buMSpUS4TLCknXygyfkbSQ2eyFqWEkv5U",
    "BD5c3pB5WCsVf4kNWpwFyMHdrY1sxCCop874CnC4ncem",
    "1".repeat(32), // system program — all-zero bytes
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  ]) {
    assert.ok(isValidAddress(addr), addr);
    assert.equal(encodeBase58(b58ToBytes(addr)), addr, `round-trip ${addr}`);
  }
});

// ---------------------------------------------------------------- on-curve
// Verdicts emitted by solders (Rust curve25519-dalek), seed 280925 for the randoms.
const ON_OFF_CURVE = [
  ["5866666666666666666666666666666666666666666666666666666666666666", true], // ed25519 base point (y = 4/5)
  ["0100000000000000000000000000000000000000000000000000000000000000", true], // identity (y = 1)
  ["0000000000000000000000000000000000000000000000000000000000000000", true], // y = 0: x^2 = -1, p ≡ 1 mod 4 → residue
  ["dc9cf2ca69d4ba9ca4b0b2abee5b2ec9bdaa5900054101843bac82f221ae5d9c", true],
  ["b970e9e7d0f270bfc716ce80c108ee8f63e7034940571c60915fed2540fc7586", true],
  ["b4ee88c98ed76dfbb215eeb7619ef30ba27791024fade8a14fce5842970f9cef", true],
  ["829455807dc2605e629472bf4e2ea38fb828b7ba88d6bc5318bf66c9152a3bff", true],
  ["e8a7695bdefa9f7dc97d114ecad8df3a71d1f7dea8f9522fd2ed7f35dc71fc32", true],
  ["f81f4f20541ff2ffe2e7b85ef3e44627e63d442b4284208936c86141c1e63337", true],
  ["012312aa423ffebfee48374a5f25271763daa74c801c2bb46a5dc3a4756dc2df", false],
  ["6c6afc47996cf7e1424430a213c3eadc4cbbb565f9ab4188bfe64171bb0552cc", false],
  ["8e34cd32c38ddc5991a5bb29c8ca8ecc8e61a2e21d9c3adb7b796ec8dcb5cfd7", false],
  ["f2e3b5fe7f60b6d79b246cce8a0ba896c2e789c434ade0d44f918a1364d15a0a", false],
  ["433b082e914aee7eeba48caf9e9e646634571fb161e5fc88ab4d56666c8fa26d", false],
  ["682b1d8510023e7ba1e341cb99473738caca3f6d4d6aecb562652606096438f7", false],
];

test("isOnCurveEd25519: 15 pinned verdicts from the independent Rust implementation", () => {
  for (const [h, expected] of ON_OFF_CURVE) assert.equal(isOnCurveEd25519(hex(h)), expected, h);
});

test("isOnCurveEd25519: non-canonical y >= p is rejected; verdict is deterministic", () => {
  assert.equal(isOnCurveEd25519(hex("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff80")), false, "y = 2^255 - 1 > p is not a canonical field element");
  assert.equal(isOnCurveEd25519(hex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")), false, "y = p is not canonical");
  for (const [h, expected] of ON_OFF_CURVE.slice(0, 4)) assert.equal(isOnCurveEd25519(hex(h)), expected, "stable across calls");
});

test("isOnCurveEd25519: statistical sanity — a random 32-byte string is on-curve about half the time", () => {
  let on = 0;
  const N = 200;
  for (let i = 0; i < N; i++) {
    const b = new Uint8Array(32);
    for (let j = 0; j < 32; j++) b[j] = Math.floor(Math.random() * 256);
    if (isOnCurveEd25519(b)) on++;
  }
  assert.ok(on > N / 4 && on < (3 * N) / 4, `${on}/${N} on-curve — a degenerate always-true/always-false check collapses`);
});

// ---------------------------------------------------------------- PDA composition
test("findProgramAddress: sha256(seeds||bump||programId||'ProgramDerivedAddress'), first off-curve bump from 255 down", () => {
  const program = hex("0000000000000000000000000000000000000000000000000000000000000001");
  const seed = hex("0000000000000000000000000000000000000000000000000000000000000002");
  // an independent reference walk (module internals not reused)
  let expected = null;
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256").update(seed).update(Uint8Array.of(bump)).update(program).update("ProgramDerivedAddress").digest();
    if (!isOnCurveEd25519(new Uint8Array(h))) { expected = { address: encodeBase58(new Uint8Array(h)), bump }; break; }
  }
  assert.deepEqual(findProgramAddress([seed], program), expected);
  assert.deepEqual(findProgramAddress([seed, seed], program), findProgramAddress([seed, seed], program), "deterministic");
});

// ---------------------------------------------------------------- ATA (the proof of the match)
test("deriveAta: 12 pinned (owner, mint, program) -> ATA triples — real repo wallets, real registry mints", () => {
  // owners: the two demo wallets of docs/DEMO_TOUR.md + docs/CTO_SESSION_MEMO.md;
  // mints: AAPLx / SPYx / TSLAx from data/tokens.json.
  // Expected values emitted by solders 0.29.0 (Rust): Pubkey::find_program_address(
  //   [owner, token_program, mint], ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL)
  const EJBQ = "EJBQLNEH1x6buMSpUS4TLCknXygyfkbSQ2eyFqWEkv5U";
  const HO = "Ho5371Kc1Kxy7ze85UYzZ4BUfSkLg39Xp3B424RuYrbC";
  const [CLASSIC, T22] = TOKEN_PROGRAMS;
  const PINS = [
    [EJBQ, "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", CLASSIC, "BhRWkv3DvmjNhEaopj9BehWqhEAxLutkjX8W2wxS6L33", 252],
    [EJBQ, "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", T22, "3WsXiio7Ji2rGLLyQQteKWV4tVYv1nPKe9D9d1d4ZmSM", 253],
    [EJBQ, "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", CLASSIC, "BD5c3pB5WCsVf4kNWpwFyMHdrY1sxCCop874CnC4ncem", 253],
    [EJBQ, "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", T22, "A8BJi1je3HKuQnTEA2BY6Z3rab4nhUaJWxgdBDFJkQso", 249],
    [EJBQ, "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", CLASSIC, "5u7kDZ9Ao8bvasyXp4tNjz7PtiUPcPn7sJwMxCfToRyq", 248],
    [EJBQ, "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", T22, "FGWibvydaNifC2VoNhdRe5ToV8u816z4q97LFoLT7WwL", 255],
    [HO, "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", CLASSIC, "HBV5bGXyek5JjrTYUHkwJU734P3e8UrUchY5ueUcj9Dy", 255],
    [HO, "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", T22, "8YtJoSSdNmkWhCGK43DEoH1FdLK9KiPcVZf929gTAHNd", 253],
    [HO, "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", CLASSIC, "D3aPThPtuyriS3vtxj2PnWAGCozDKE64LQuha5LnSNxy", 253],
    [HO, "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", T22, "2oEhkmn3EdwgACkzFZfPmMVSn6oYKRyMbrXKxJwianAF", 255],
    [HO, "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", CLASSIC, "DVQJmtmQS3FBVwaAK7Gn14LnRUMzrAmxKe59si6pPWXy", 252],
    [HO, "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", T22, "DPnKAe2vkiuTGr5pvSqcKosx3491WRZ6wxXooxSeZ3Nn", 253],
  ];
  for (const [owner, mint, program, ata, bump] of PINS) {
    assert.equal(deriveAta(owner, mint, program), ata, `${owner.slice(0, 6)}… x ${program === CLASSIC ? "classic" : "token2022"}`);
    // the bump is pinned through the same building block: rebuilding the seeds from the
    // pinned owner/mint/program must reproduce not only the address but the bump
    assert.equal(findProgramAddress([b58ToBytes(owner), b58ToBytes(program), b58ToBytes(mint)], b58ToBytes(ASSOC_TOKEN_PROGRAM_ID)).bump, bump);
  }
});

test("derived ATA is a structurally valid pubkey, deterministic, distinct from owner and mint", () => {
  const owner = "EJBQLNEH1x6buMSpUS4TLCknXygyfkbSQ2eyFqWEkv5U";
  const mint = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
  for (const program of TOKEN_PROGRAMS) {
    const ata = deriveAta(owner, mint, program);
    assert.ok(isValidAddress(ata), `${ata} decodes to exactly 32 bytes`);
    assert.notEqual(ata, owner);
    assert.notEqual(ata, mint);
    assert.equal(deriveAta(owner, mint, program), ata, "deterministic");
  }
  assert.notEqual(deriveAta(owner, mint, TOKEN_PROGRAMS[0]), deriveAta(owner, mint, TOKEN_PROGRAMS[1]), "classic ATA != token2022 ATA");
});
