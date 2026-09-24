// Фавиконка витрины (брендинг-батч 24.09): inline SVG data-URI в <head> — судьи
// видят лого «L» на табе браузера в демо-видео; новый файл/роут не нужны.
// Ингредиенты марки те же, что у assets/logo-mark.svg, но одним цветом #58a6ff:
// у data-URI нет CSS-контекста страницы, currentColor некуда наследовать, а
// нейтральный инк (#e6edf0 / #1f2328) пропадает на светлом или тёмном таб-баре.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../src/ui/page.mjs";

test("vitrine: фавиконка — L-марка одним акцентом как SVG data-URI внутри <head>", () => {
  const html = renderPage();
  const m = html.match(/<link rel="icon"[^>]*href="data:image\/svg\+xml,([^"]+)"/);
  assert.ok(m, "link rel=icon с SVG data-URI присутствует");
  const svg = decodeURIComponent(m[1]);
  assert.match(svg, /<svg[^>]*viewBox="0 0 32 32"/, "квадратная сетка марки");
  assert.match(svg, /rect[^>]+fill="#58a6ff"/, "ствол/нога L видны на любом таб-баре");
  assert.match(svg, /<circle/, "точка-event на месте");
  assert.ok(html.indexOf('<link rel="icon"') < html.indexOf("</head>"), "линк внутри head");
});
