// Jev-ревьюер публичных артефактов (README.en.md, SUBMISSION_DRAFT.md …).
// Типизированные вердикты TypeSafe System One (Jev): ai_tells (noul), clarity (score),
// unsupported_claims (noul) — по каждой ##-секции документа.
// Запуск: node scripts/jev-review.mjs [файлы...] (по умолчанию README.en.md и
// docs/SUBMISSION_DRAFT.md). Ключ в TYPESAFE_API_KEY. Dev-инструмент: сеть только сюда,
// в рантайме продукта не участвует, зависимостей нет.
import { readFileSync } from "node:fs";

const API = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

// Чистые части (тестируются без сети): разбор секций, вопросы, агрегат вердикта.

export function splitSections(markdown) {
  const lines = markdown.split("\n");
  const out = [];
  let title = "(preamble)";
  let buf = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (buf.join("").trim()) out.push({ title, text: buf.join("\n").trim() });
      title = line.replace(/^##\s+/, "").trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (buf.join("").trim()) out.push({ title, text: buf.join("\n").trim() });
  // Секция без содержания (только вложенные заголовки) не судится
  return out.filter((s) => s.text.length > 40);
}

export function buildQuestions() {
  return {
    ai_tells: {
      type: "noul",
      instructions:
        "Does `text` read as AI-generated boilerplate? Judge the writing style only, not the topic.",
      criteria: {
        true:
          "Typical LLM tells are present: not-X-but-Y contrast frames, rule-of-three padding, em-dash overuse, hollow superlatives (seamless, revolutionary, unlock, cutting-edge), grand restatements of the obvious",
        false: "Plain engineer-written prose: specific, concrete, no template phrasing",
      },
    },
    clarity: {
      type: "score",
      instructions:
        "How clear is `text` to a hackathon judge reading it for the first time? The judge knows crypto basics but nothing about this project.",
      criteria: [
        "Confusing: the judge cannot tell what this is about",
        "Understandable but muddled in places; requires rereading",
        "Clear: the judge grasps the point in one pass",
        "Crisp: instantly clear, specific, and easy to remember",
      ],
    },
    unsupported_claims: {
      type: "noul",
      instructions:
        "Does `text` state concrete claims (numbers, named outcomes, capabilities) that are neither self-evident nor explained within the text and would need external verification to trust?",
      criteria: {
        true: "At least one concrete claim appears out of nowhere, with no derivation or reference",
        false: "Claims are either explained, self-evident, or properly attributed within the text",
      },
    },
  };
}

// Пороги: noul-флаги при >= 0.5, clarity тревога при score < 1.5 (шкала 0..3).
export function verdictOf(answers) {
  const flags = [];
  if (answers.ai_tells?.noul >= 0.5) flags.push("ai-tells");
  if (answers.unsupported_claims?.noul >= 0.5) flags.push("unsupported-claims");
  if (answers.clarity?.score < 1.5) flags.push("unclear");
  return flags;
}

export async function askJev(sections, { apiKey, fetcher = fetch } = {}) {
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
  const results = [];
  for (const s of sections) {
    const res = await fetcher(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        state: { file: s.file, section: s.title, text: s.text },
        questions: buildQuestions(),
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status} for section "${s.title}"`);
    const j = await res.json();
    results.push({ section: s.title, file: s.file, answers: j.answers, flags: verdictOf(j.answers) });
  }
  return results;
}

async function main(argv) {
  const files = argv.length ? argv : ["README.md", "docs/SUBMISSION_DRAFT.md"];
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.error("нет TYPESAFE_API_KEY — Jev-ревью недоступно");
    return 2;
  }
  const sections = [];
  for (const f of files) sections.push(...splitSections(readFileSync(f, "utf8")).map((s) => ({ ...s, file: f })));
  console.log(`Jev-ревью: ${sections.length} секций из ${files.length} файлов`);
  const results = await askJev(sections, { apiKey });
  let flagged = 0;
  for (const r of results) {
    const mark = r.flags.length ? "⚠ " + r.flags.join(",") : "ok";
    if (r.flags.length) flagged++;
    const ai = (r.answers.ai_tells?.noul ?? 0).toFixed(2);
    const cl = (r.answers.clarity?.score ?? 0).toFixed(2);
    const un = (r.answers.unsupported_claims?.noul ?? 0).toFixed(2);
    console.log(`[${mark}] ${r.file} :: ${r.section} — ai=${ai} clarity=${cl}/3 unsupported=${un}`);
  }
  console.log(`ИТОГ: ${sections.length - flagged}/${sections.length} секций чистые`);
  return flagged ? 1 : 0;
}

if (process.argv[1]?.endsWith("jev-review.mjs") && process.platform !== "win32") {
  process.exit(await main(process.argv.slice(2)));
} else if (process.argv[1]?.endsWith("jev-review.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(2);
    },
  );
}
