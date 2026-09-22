import test from "node:test";
import assert from "node:assert/strict";
import { splitSections, buildQuestions, verdictOf } from "../scripts/jev-review.mjs";

test("splitSections: режет по ##, короткие секции выбрасывает", () => {
  const md = "# Title\nвступление короткое\n## A\n" + "текст секции A ".repeat(10) + "\n## B\nкоротко\n";
  const s = splitSections(md);
  assert.equal(s.length, 1);
  assert.equal(s[0].title, "A");
});

test("splitSections: без ## весь текст — одна секция (preamble)", () => {
  const s = splitSections("просто длинный текст без заголовков ".repeat(5));
  assert.equal(s.length, 1);
  assert.equal(s[0].title, "(preamble)");
});

test("buildQuestions: три вопроса, типы на месте", () => {
  const q = buildQuestions();
  assert.equal(q.ai_tells.type, "noul");
  assert.equal(q.clarity.type, "score");
  assert.equal(q.clarity.criteria.length, 4);
  assert.equal(q.unsupported_claims.type, "noul");
});

test("verdictOf: пороги — ai>=0.5, unsupported>=0.5, clarity<1.5", () => {
  assert.deepEqual(verdictOf({ ai_tells: { noul: 0.49 }, unsupported_claims: { noul: 0.2 }, clarity: { score: 2 } }), []);
  assert.deepEqual(verdictOf({ ai_tells: { noul: 0.5 }, unsupported_claims: { noul: 0.2 }, clarity: { score: 2 } }), ["ai-tells"]);
  assert.deepEqual(verdictOf({ ai_tells: { noul: 0.1 }, unsupported_claims: { noul: 0.51 }, clarity: { score: 2 } }), ["unsupported-claims"]);
  assert.deepEqual(verdictOf({ ai_tells: { noul: 0.1 }, unsupported_claims: { noul: 0.2 }, clarity: { score: 1.4 } }), ["unclear"]);
});

test("verdictOf: отсутствующие ответы не роняют агрегат", () => {
  assert.deepEqual(verdictOf({}), []);
});
