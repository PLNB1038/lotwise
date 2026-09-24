// Витрина Lotwise: одна самодостаточная страница-отчёт (sample consumer API).
// Без зависимостей и внешних ресурсов: только относительные fetch к своему же API.
// Публичная сторона — английский, без эмодзи, только проверяемые факты из эндпоинтов.

// Фавиконка = та же L-марка (assets/logo-mark.svg), но одним акцентом #58a6ff:
// у data-URI нет CSS-контекста страницы — currentColor наследовать неоткуда, а
// нейтральный инк (#e6edf0/#1f2328) пропадает на светлом или тёмном таб-баре.
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect x="4.5" y="4" width="4" height="24" rx="2" fill="#58a6ff"/>' +
  '<rect x="4.5" y="24.5" width="21" height="3.5" rx="1.75" fill="#58a6ff"/>' +
  '<circle cx="6.5" cy="13" r="2.3" fill="#58a6ff"/></svg>';
const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

export function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">
<title>Lotwise — corporate actions engine for tokenized equities</title>
<style>
  :root {
    --bg: #0d1117; --card: #161b22; --border: #30363d;
    --text: #e6edf0; --muted: #8b949e; --accent: #58a6ff;
    --ok: #3fb950; --warn: #d29922; --bad: #f85149; --mono: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, "Segoe UI", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .3px; }
  h1 span { color: var(--accent); }
  .brand { display: flex; align-items: center; gap: 10px; margin: 0 0 4px; }
  .brand h1 { margin: 0; }
  .brand-mark { flex: none; color: var(--text); }
  .brand-mark .accent { fill: var(--accent); }
  .tagline { color: var(--muted); margin: 0 0 18px; max-width: 720px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 22px; }
  .stat { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 16px; }
  .stat b { font-family: var(--mono); font-size: 20px; display: block; }
  .stat i { font-style: normal; color: var(--muted); font-size: 12px; }
  section { margin-top: 28px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted); margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 14px; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
  tr:last-child td { border-bottom: none; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: #1c2129; }
  tr.selected { background: #1f2937; }
  td.num, th.num { text-align: right; font-family: var(--mono); }
  .badge { display: inline-block; border: 1px solid var(--border); border-radius: 10px; padding: 0 8px; font-size: 12px; color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .card h3 { margin: 0 0 8px; font-size: 14px; }
  .kv { display: grid; grid-template-columns: 220px 1fr; gap: 4px 12px; font-size: 14px; }
  .kv dt { color: var(--muted); } .kv dd { margin: 0; font-family: var(--mono); word-break: break-all; }
  .verdict { font-family: var(--mono); font-size: 13px; padding: 2px 10px; border-radius: 10px; border: 1px solid var(--border); }
  .verdict.ok { color: var(--ok); border-color: var(--ok); }
  .verdict.disagree { color: var(--bad); border-color: var(--bad); }
  .verdict.unavailable { color: var(--warn); border-color: var(--warn); }
  .timeline .verdict { font-size: 11px; padding: 0 6px; margin-left: 6px; cursor: help; }
  .note { color: var(--muted); font-size: 13px; }
  input[type=number], input[type=date], select {
    background: #0d1117; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-family: var(--mono); font-size: 14px;
  }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
  button { background: #21262d; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 14px; font-size: 14px; cursor: pointer; }
  button:hover { border-color: var(--accent); color: var(--accent); }
  #detail { display: none; }
  .timeline { list-style: none; padding: 0; margin: 0; }
  .timeline li { padding: 8px 0 8px 18px; border-left: 2px solid var(--border); position: relative; }
  .timeline li::before { content: ""; position: absolute; left: -5px; top: 15px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  .timeline .when { font-family: var(--mono); color: var(--muted); font-size: 13px; }
  .timeline .what { font-family: var(--mono); font-size: 14px; }
  footer { margin-top: 40px; color: var(--muted); font-size: 13px; }
  footer code { font-family: var(--mono); color: var(--accent); }
  .err { color: var(--warn); font-size: 13px; }
</style>
</head>
<body>
<main>
  <header class="brand">
    <svg class="brand-mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false">
      <!-- знак Lotwise: стек налоговых лотов на оси событий; акцентный лот — пересчитанный корпсобытием -->
      <line x1="5.25" y1="4.75" x2="5.25" y2="27.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="5.25" cy="13" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <rect x="10" y="5" width="17" height="3.5" rx="1.75" fill="currentColor"/>
      <rect x="10" y="11.25" width="20" height="3.5" rx="1.75" fill="#58a6ff" class="accent"/>
      <rect x="10" y="17.5" width="13" height="3.5" rx="1.75" fill="currentColor"/>
      <rect x="10" y="23.75" width="10" height="3.5" rx="1.75" fill="currentColor"/>
    </svg>
    <h1><span>Lotwise</span> — corporate actions engine for tokenized equities</h1>
  </header>
  <p class="tagline">Tokenized stocks split and pay dividends while the raw on-chain balance stays
    frozen — the economics move under a number that does not, so any report computed from raw
    transfers quietly drifts from reality. Lotwise normalizes issuer APIs (xStocks, PreStocks,
    Tessera) and on-chain mint state into one validated event stream, then recomputes what a
    position is actually worth: adjusted balances, FIFO lots with exact dust, and a per-event
    price cross-check. This page is a live sample consumer of the REST API — every number on it
    comes from an endpoint.</p>

  <div class="stats" id="stats"></div>

  <!-- Дивидендный слой: статичный редакторский контекст (не данные — данные выше и ниже
       берутся из API). Тикеры перечислены поимённо без счётчиков, чтобы копирайт не разъехался
       с реестром; факт «событий пока нет» привязан к дате расширения, а не к моменту чтения. -->
  <section id="dividend-layer">
    <h2>Dividend layer</h2>
    <div class="card">
      <p>The event schema includes <code>DIVIDEND_ACCRUAL</code>: an issuer-declared amount per
        unit (exact raw integer and decimals), credited by the FIFO lot engine to every holder on
        the ex-date. Until Sep 22, 2026 the registry held only growth and pre-IPO tokens, so this
        path had no real material. It now covers classic dividend payers from issuer Backed
        (xStocks) — JPMx (JPMorgan Chase), KOx (Coca-Cola), Vx (Visa), XOMx (Exxon Mobil) — plus
        QQQx (Nasdaq-100 ETF), the ETF sibling of the tracked SPYx. Mints were taken from the
        issuer API and verified on mainnet (Token-2022, 8 decimals). As of that expansion none of
        them has a normalized corporate action yet — their rows show multiplier 1 until the first
        dividend or split reaches the pipeline.</p>
    </div>
  </section>

  <section>
    <h2>Tracked tokens</h2>
    <table>
      <thead><tr><th>Symbol</th><th>Name</th><th>Issuer</th><th class="num">Events</th><th class="num">Multiplier today</th></tr></thead>
      <tbody id="tokens"></tbody>
    </table>
  </section>

  <section id="wallet">
    <h2>Wallet report</h2>
    <div class="card">
      <div class="row">
        <label>Address <input id="addr-in" placeholder="Solana wallet" size="46" spellcheck="false"></label>
        <button id="scan-btn">Scan</button>
      </div>
      <p class="note">Scans the wallet history on-chain and rebuilds tax lots for tracked tokens.
        Raw balances are shown as stored on-chain; the adjusted view applies the multiplier timeline.
        A first scan of an active wallet can take a minute on public RPC.</p>
      <div id="wallet-out"></div>
    </div>
  </section>

  <section id="detail">
    <h2 id="detail-title"></h2>

    <div class="card" id="planes-card">
      <h3>Planes reconcile — issuer API vs on-chain Scaled UI <span id="verdict" class="verdict unavailable">loading</span></h3>
      <dl class="kv" id="planes"></dl>
      <p class="note" id="planes-note">The issuer API and the token mint itself are two independent
        planes describing the same multiplier. Lotwise reconciles them on every read.</p>
    </div>

    <div class="card">
      <h3>Raw to adjusted calculator</h3>
      <div class="row">
        <label>Raw amount <input type="number" id="raw-in" step="any" min="0" value="1.5"></label>
        <label>Date <input type="date" id="date-in"></label>
        <button id="calc">Compute</button>
      </div>
      <dl class="kv" id="calc-out"></dl>
    </div>

    <div class="card">
      <h3>Event history</h3>
      <ul class="timeline" id="events"></ul>
    </div>
  </section>

  <footer>
    This page is a sample consumer of the Lotwise REST API:
    <code>/health</code> <code>/tokens</code> <code>/events</code> <code>/multiplier</code> <code>/summary</code> <code>/onchain</code> <code>/lots</code> <code>/accruals</code> <code>/crosscheck</code>.
    Registry size, issuers and event totals come live from <code>/health</code> — nothing is
    hardcoded in this page (registry expanded with the dividend layer on Sep 22, 2026).
  </footer>
</main>

<script>
'use strict';
var state = { tokens: [], selected: null };

function el(id) { return document.getElementById(id); }
function fmtMul(s) { return s === '1' ? '1' : s; }
function todayISO() { return new Date().toISOString().slice(0, 10); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Баннер повреждения источника (0|1 из /health, контракт с boot-зоной): falsy — тишина,
// truthy — тот же стиль честного warn, что у unavailable/excluded.
function corruptionStat(value, label) {
  if (!value) return '';
  return '<div class="stat"><b class="err">' + esc(value) + '</b><i>' + esc(label) +
    ' — multipliers may be incomplete, restored by backfill</i></div>';
}

function renderStats(h, tokens) {
  var issuers = {};
  tokens.forEach(function (t) { issuers[t.issuer] = true; });
  el('stats').innerHTML =
    '<div class="stat"><b>' + esc(h.tokens) + '</b><i>tokens tracked</i></div>' +
    '<div class="stat"><b>' + esc(h.events) + '</b><i>events normalized</i></div>' +
    '<div class="stat"><b>' + Object.keys(issuers).length + '</b><i>issuers</i></div>' +
    '<div class="stat"><b>fail-closed</b><i>reconcile policy</i></div>';
  // RPC мог лежать на старте: journal.unavailable — токены, не прочитанные из цепи,
  // и по ним витрина рисует множитель «1». Молчать = тихая ложь, показываем честный warn.
  if (h.journal && h.journal.unavailable > 0) {
    el('stats').innerHTML +=
      '<div class="stat"><b class="err">' + esc(h.journal.unavailable) + '</b>' +
      '<i>tokens unavailable at startup — multipliers may be understated</i></div>';
  }
  // Токены, исключённые из витрины по кривому таймлайну (health.excluded[] с сервера):
  // строка с «1» в таблице без пометки неотличима от честного «событий не было».
  if (h.excluded && h.excluded.length > 0) {
    el('stats').innerHTML +=
      '<div class="stat"><b class="err">' + esc(h.excluded.length) + '</b>' +
      '<i>tokens excluded from multiplier reporting — shown as excluded, not computed</i></div>';
  }
  // Повреждения источников на старте: журнал повреждён (бэкфилл восстановил не всё),
  // улика не сохранена (переименовать битый файл не удалось), реестр повреждён.
  // Молчать = тихая ложь — тот же класс, что unavailable/excluded выше.
  el('stats').innerHTML +=
    corruptionStat(h.journal && h.journal.corrupted, 'journal corrupted at startup') +
    corruptionStat(h.journal && h.journal.preserveFailed, 'corrupted journal could not be preserved') +
    corruptionStat(h.registry && h.registry.corrupted, 'token registry corrupted at startup');
}

function renderTokens(list) {
  el('tokens').innerHTML = list.map(function (t) {
    return '<tr data-symbol="' + esc(t.symbol) + '">' +
      '<td>' + esc(t.symbol) + '</td>' +
      '<td>' + esc(t.name) + '</td>' +
      '<td><span class="badge">' + esc(t.issuer) + '</span></td>' +
      '<td class="num">' + esc(t.events) + '</td>' +
      '<td class="num">' + (t.excluded
        ? '<span class="err" title="' + esc(t.excludedReason || 'timeline error') + '">excluded</span>'
        : esc(fmtMul(t.currentMultiplier))) + '</td></tr>';
  }).join('');
  document.querySelectorAll('#tokens tr').forEach(function (tr) {
    tr.onclick = function () { select(tr.getAttribute('data-symbol')); };
  });
}

function select(symbol) {
  var t = null;
  for (var i = 0; i < state.tokens.length; i++) {
    if (state.tokens[i].symbol === symbol) { t = state.tokens[i]; break; }
  }
  if (!t) return;
  state.selected = t;
  Array.prototype.forEach.call(document.querySelectorAll('#tokens tr'), function (tr) {
    tr.className = tr.getAttribute('data-symbol') === symbol ? 'selected' : '';
  });
  el('detail').style.display = 'block';
  el('detail-title').textContent = t.symbol + ' — ' + t.name;
  el('date-in').value = todayISO();
  // смена токена чистит панели ДО загрузки (волна D1): события/расчёт прошлого
  // токена не висят под заголовком нового, пока его ответы в полёте
  el('events').innerHTML = '<li class="note">loading events…</li>';
  el('calc-out').innerHTML = '';
  loadEvents(t);
  loadPlanes(t);
  calc();
  document.getElementById('detail').scrollIntoView({ behavior: 'smooth' });
}

function eventsError(msg) {
  el('events').innerHTML = '<li><span class="what err">' + esc(msg) + '</span></li>';
}

// Ключ кросс-чек-бейджа: тип события + effectiveDate + порядковый номер среди событий
// СВОЕГО типа. Ключевание по одной только дате коллидировало: два события в один день —
// и первое показывало вердикт второго (Map затирался); ребейз и дивиденд в один день
// затёрлись бы и при совпадении номеров — разводим префиксом типа. /crosscheck отдаёт
// вердикты блоками в порядке событий: сначала все MULTIPLIER_CHANGE, затем DIVIDEND_ACCRUAL
// (контракт витрины), поэтому пара (тип, seq) однозначно склеивает пару.
function xcKey(e, seq) {
  return (e.type === 'DIVIDEND_ACCRUAL' ? 'div' : 'mult') + '#' + e.effectiveDate + '#' + seq;
}

function loadEvents(t) {
  fetch('/events?symbol=' + encodeURIComponent(t.symbol))
    .then(function (r) { return r.json().then(function (list) { return { ok: r.ok, status: r.status, list: list }; }); })
    .then(function (res) {
      if (state.selected !== t) return; // устаревший ответ: пользователь уже переключил токен
      // не-массив ({error} от 500) — не «пустая история»: показываем ошибку, не маскируем
      if (!res.ok || !Array.isArray(res.list)) {
        eventsError('Event history unavailable (HTTP ' + res.status +
          (res.list && res.list.error ? ': ' + res.list.error : '') + ')');
        return;
      }
      renderEvents(res.list, null);
      if (!res.list.length) return;
      // вердикты кросс-чека цены приходят вторым заходом и дополняют таймлайн бейджами
      fetch('/crosscheck?symbol=' + encodeURIComponent(t.symbol))
        .then(function (r) { return r.json(); })
        .then(function (xc) {
          if (state.selected !== t) return;
          var byKey = {};
          var vi = 0; // порядковый номер среди MULTIPLIER_CHANGE
          var di = 0; // порядковый номер среди DIVIDEND_ACCRUAL
          var numMult = 0;
          res.list.forEach(function (e) { if (e.type === 'MULTIPLIER_CHANGE') numMult += 1; });
          res.list.forEach(function (e) {
            var isMult = e.type === 'MULTIPLIER_CHANGE';
            if (!isMult && e.type !== 'DIVIDEND_ACCRUAL') return;
            // вердикты идут блоками: сначала все ребейзы (в порядке событий), затем все
            // дивиденды (в порядке событий) — индекс вердикта = позиция события в своём блоке
            var seq = isMult ? vi : di;
            var idx = isMult ? vi : numMult + di;
            if (isMult) vi += 1; else di += 1;
            if (xc.verdicts && xc.verdicts[idx]) byKey[xcKey(e, seq)] = xc.verdicts[idx];
          });
          renderEvents(res.list, byKey);
        })
        .catch(function () { /* бейджи — обогащение, не данные: молча без них */ });
    })
    .catch(function (e) {
      // сеть/рестарт сервера: без catch — unhandled rejection и ЧУЖОЙ таймлайн
      // предыдущего токена оставался под новым заголовком. Честная err-заметка.
      if (state.selected !== t) return;
      eventsError('Event history unavailable: ' + e.message);
    });
}

// Доля падения цены со знаком (drop-семантика): падение — с минусом, рост — с плюсом.
function pctDrop(f) { return (f < 0 ? '+' : '-') + (Math.abs(f) * 100).toFixed(3) + '%'; }

// Цвет бейджа — по verdict, тот же набор классов, что у ребейза; подпись своя:
// «dividend: …» отличает дивидендный вердикт от ребейзного «price: …» с первого взгляда.
function xcBadge(v) {
  if (!v) return '';
  var kind = v.type === 'DIVIDEND_ACCRUAL' ? 'dividend' : 'price';
  var map = {
    consistent: ['ok', kind + ': consistent'],
    mismatch: ['disagree', kind + ': mismatch'],
    suspicious: ['disagree', kind + ': suspicious'],
    inconclusive: ['unavailable', kind + ': inconclusive'],
    'no-price-data': ['unavailable', kind + ': no data'],
  };
  var m = map[v.verdict] || ['unavailable', kind + ': ?'];
  var tip = v.note || '';
  // числа сравнения дивиденда — компактно в тултип, как у ребейза через note:
  // доли pre-ex цены безразмерны, долларов и FX у вердикта честно нет
  if (kind === 'dividend' && v.expectedDropFraction != null && v.observedDropFraction != null) {
    tip = 'expected ' + pctDrop(v.expectedDropFraction) + ' vs observed ' + pctDrop(v.observedDropFraction) +
      (tip ? ' — ' + tip : '');
  }
  return ' <span class="verdict ' + m[0] + '" title="' + esc(tip) + '">' + m[1] + '</span>';
}

function renderEvents(list, xcByKey) {
  if (!list.length) {
    el('events').innerHTML = '<li><span class="what">No normalized events for this token yet.</span></li>';
    return;
  }
  var seqM = 0; // порядковый среди MULTIPLIER_CHANGE — тот же, что при ключовании вердиктов
  var seqD = 0; // порядковый среди DIVIDEND_ACCRUAL — дивиденд живёт отдельной строкой
  el('events').innerHTML = list.map(function (e) {
    var isMult = e.type === 'MULTIPLIER_CHANGE';
    var isDiv = e.type === 'DIVIDEND_ACCRUAL';
    var key = null;
    if (isMult) { key = xcKey(e, seqM); seqM += 1; }
    else if (isDiv) { key = xcKey(e, seqD); seqD += 1; }
    var title = isDiv ? 'dividend accrual' : (e.reason || e.type);
    // дивиденд — не смена множителя: вместо from → to своя величина начисления
    // (raw → human по decimals события; decimals неизвестны — fmtUi честно скажет об этом)
    var what = isDiv
      ? esc(fmtUi(e.amountPerUnitRaw, e.decimals)) + ' per unit'
      : esc(e.multiplierFrom || '-') + ' &rarr; ' + esc(e.multiplierTo || '-');
    return '<li><div class="when">' + esc(e.effectiveDate) + ' — ' + esc(title) +
      xcBadge(xcByKey && key !== null ? xcByKey[key] : null) + '</div>' +
      '<div class="what">' + what + '</div></li>';
  }).join('');
}

function setVerdict(cls, text) {
  var v = el('verdict');
  v.className = 'verdict ' + cls;
  v.textContent = text;
}

function loadPlanes(t) {
  setVerdict('unavailable', 'loading');
  el('planes').innerHTML = '';
  fetch('/onchain?symbol=' + encodeURIComponent(t.symbol))
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
    .then(function (res) {
      if (state.selected !== t) return; // устаревший ответ
      if (!res.ok) {
        setVerdict('unavailable', 'unavailable');
        el('planes').innerHTML = '<dt>on-chain source</dt><dd class="err">' +
          esc(res.body.error || 'unavailable') + ' — fail-closed, not guessing</dd>';
        return;
      }
      var b = res.body;
      var rows =
        '<dt>issuer API multiplier</dt><dd>' + esc(b.api) + '</dd>' +
        '<dt>on-chain active</dt><dd>' + esc(b.onChain.active) + '</dd>' +
        '<dt>on-chain pending</dt><dd>' + esc(b.onChain.pending || 'none') +
        (b.onChain.pendingEffectiveDate ? ' (activates ' + esc(b.onChain.pendingEffectiveDate) + ')' : '') + '</dd>' +
        '<dt>on-chain effective</dt><dd>' + esc(b.onChainEffective) + '</dd>';
      if (!b.onChain.hasExtension) {
        rows += '<dt>extension</dt><dd>scaledUiAmount not present — plain token, multiplier 1</dd>';
      }
      el('planes').innerHTML = rows;
      if (b.verdict === 'ok') setVerdict('ok', 'planes agree');
      else setVerdict('disagree', 'planes disagree');
    })
    .catch(function (e) {
      if (state.selected !== t) return; // чужая ошибка не ложится на новый токен (волна D1)
      setVerdict('unavailable', 'unavailable');
      el('planes').innerHTML = '<dt>on-chain source</dt><dd class="err">' + esc(e.message) + '</dd>';
    });
}

var calcSeq = 0;
function calc() {
  var t = state.selected;
  var mySeq = ++calcSeq; // эпоха: устаревший пересчёт не перерисовывается (волна D1)
  if (!t) return;
  var rawIn = (el('raw-in').value || '0').trim();
  if (!/^\\d*(\\.\\d*)?$/.test(rawIn) || rawIn === '' || rawIn === '.') {
    el('calc-out').innerHTML = '<dt>input</dt><dd class="err">enter a non-negative amount, e.g. 1.5</dd>';
    return;
  }
  // decimals null (реестр до enrich-decimals): UI-число в базовые юниты честно не
  // конвертировать — показываем ввод как есть, калькулятор не считает, не выдумывая 0
  if (t.decimals == null) {
    el('calc-out').innerHTML =
      '<dt>input</dt><dd>' + esc(rawIn) + '</dd>' +
      '<dt>decimals</dt><dd class="err">decimals unknown for this token — conversion skipped, not guessing</dd>';
    return;
  }
  // UI-число -> целые базовые юниты строкой, без float-магии
  var parts = rawIn.split('.');
  var base = parts[0] || '0';
  var frac = parts[1] || '';
  // точность сверх decimals базовыми юнитами не выражается — обрезаем и честно помечаем
  var truncated = frac.length > t.decimals && frac.slice(t.decimals).replace(/0+$/, '') !== '';
  var padded = (frac + '0'.repeat(Math.max(0, t.decimals - frac.length))).slice(0, t.decimals);
  var raw = BigInt(base + padded);
  var qs = '/multiplier?symbol=' + encodeURIComponent(t.symbol) +
    '&raw=' + raw.toString() + '&date=' + encodeURIComponent(el('date-in').value || todayISO());
  fetch(qs)
    .then(function (r) { return r.json(); })
    .then(function (m) {
      if (mySeq !== calcSeq || state.selected !== t) return; // устаревший ответ (эпоха — волна D1)
      // {error}-тело от 400/500: json успел, данных нет — показываем причину честно
      if (m && m.error) {
        el('calc-out').innerHTML = '<dt>api</dt><dd class="err">' + esc(m.error) + '</dd>';
        return;
      }
      // токен без таймлайна: короткий ответ без sampleScaledQty — adjusted вычислить
      // нечем, а «1» из ответа — дефолт, не расчёт; показываем приписку, не TypeError
      var s = m && m.sampleScaledQty;
      if (!s) {
        el('calc-out').innerHTML =
          '<dt>multiplier</dt><dd class="err">multiplier unavailable for this token — no timeline, adjusted not computed</dd>';
        return;
      }
      var dust = s.exact ? 'no dust — division is exact' : 'dust shown exactly: remainder ' + esc(s.remainder) + '/' + esc(s.den) + ' base units';
      el('calc-out').innerHTML =
        '<dt>raw (base units)</dt><dd>' + raw.toString() + '</dd>' +
        '<dt>multiplier at ' + esc(m.date.slice(0, 10)) + '</dt><dd>' + esc(m.multiplier) + '</dd>' +
        // числовые-по-контракту поля тоже эскейпим (ROUND7 №9): строка в них —
        // мимо контракта, но silent stored-XSS дороже одного вызова esc()
        '<dt>adjusted (base units)</dt><dd>' + esc(s.whole) + (s.exact ? '' : ' + ' + esc(s.remainder) + '/' + esc(s.den)) + '</dd>' +
        '<dt>remainder policy</dt><dd>' + dust + '</dd>' +
        (truncated ? '<dt>input precision</dt><dd class="err">amount exceeds ' + t.decimals + ' token decimals — truncated to base units</dd>' : '');
    })
    .catch(function (e) {
      if (mySeq !== calcSeq || state.selected !== t) return; // устаревшая попытка молчит (волна D1)
      el('calc-out').innerHTML = '<dt>api</dt><dd class="err">' + esc(e.message) + '</dd>';
    });
}

document.getElementById('calc').onclick = calc;
el('date-in').onchange = calc;
el('raw-in').onchange = calc;

function fmtUi(rawStr, decimals) {
  var s = String(rawStr);
  var sign = '';
  if (s[0] === '-') { sign = '-'; s = s.slice(1); }
  // decimals null (реестр до enrich-decimals): сырые base units с пометкой,
  // а не «.» от slice(0, -null) — ноль децималов не выдумываем
  if (decimals == null) return sign + s + ' base units (decimals unknown)';
  if (decimals === 0) return sign + s;
  while (s.length <= decimals) s = '0' + s;
  return sign + s.slice(0, -decimals) + '.' + s.slice(-decimals);
}

function scanWalletUi() {
  var addr = (el('addr-in').value || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) {
    el('wallet-out').innerHTML = '<p class="err">Enter a valid Solana address (base58).</p>';
    return;
  }
  var myAddr = addr; // захват адреса: ответ чужого скана рендерить нельзя
  el('wallet-out').innerHTML = '<p class="note">Scanning wallet on-chain — first scan of an active wallet can take up to a minute.</p>';
  fetch('/lots?address=' + encodeURIComponent(addr))
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
    .then(function (res) {
      // гонка Scan/Scan: пользователь поправил адрес, пока шёл долгий скан — дозревший
      // ответ старого адреса не перезаписывает витрину (тот же класс гвардов,
      // что у state.selected для токенов)
      if ((el('addr-in').value || '').trim() !== myAddr) return;
      if (!res.ok) {
        el('wallet-out').innerHTML = '<p class="err">' + esc(res.body.error || 'scan failed') + '</p>';
        return;
      }
      renderWallet(res.body);
    })
    .catch(function (e) {
      // та же гонка для ошибок: ругаться на упавший запрос чужого адреса — ложь
      if ((el('addr-in').value || '').trim() !== myAddr) return;
      el('wallet-out').innerHTML = '<p class="err">' + esc(e.message) + '</p>';
    });
}

function renderWallet(rep) {
  var c = rep.counts;
  // исключённые токены в отчёте: их множитель — дефолт, adjusted не вычислялся
  var excludedCount = 0;
  rep.tokens.forEach(function (x) { if (x.excluded) excludedCount += 1; });
  var head = '<dl class="kv">' +
    '<dt>owner</dt><dd>' + esc(rep.owner) + '</dd>' +
    '<dt>report generated at</dt><dd>' + esc(rep.now || '—') + '</dd>' +
    '<dt>signatures scanned</dt><dd>' + esc(c.signatures) + ' (' + esc(c.fetched) + ' fetched, ' + esc(c.skipped) + ' skipped)</dd>' +
    '<dt>scan window</dt><dd>' + (rep.truncated ? 'truncated at cap — older history not scanned' : 'full history') + '</dd>' +
    '<dt>completeness</dt><dd' + (rep.complete ? '' : ' class="err"') + '>' +
      (rep.complete ? 'complete' : 'has gaps — lots may miss an opening balance') +
      (excludedCount > 0 ? ' — ' + excludedCount + ' tokens excluded' : '') + '</dd></dl>';
  var body = rep.tokens.length === 0
    ? '<p class="note">No tracked tokens found in this wallet.</p>'
    : rep.tokens.map(function (t) {
        // adjusted не вычислялся: токен исключён из множителей (t.excluded) или API честно
        // сообщил adjustedAvailable:false (excluded-минт). Сырой fallback-баланс нельзя
        // показывать как «adjusted (exact)» — это та же тихая ложь «adjusted = raw».
        var noAdjusted = t.excluded || t.adjustedAvailable === false;
        var gaps = t.gaps.length
          ? '<dt class="err">scan gap</dt><dd class="err">' + t.gaps.map(function (g) {
              return esc(g.missingQtyRaw) + ' base units predate the scan window' + (g.date ? ' (by ' + esc(g.date) + ')' : '');
            }).join('; ') + '</dd>'
          : '';
        return '<div class="card"><h3>' + esc(t.symbol) + ' — ' + esc(t.name) + '</h3><dl class="kv">' +
          '<dt>' + (t.reconciles ? 'raw balance (reconciles with chain)' : 'net delta of scan window — not an on-chain balance') + '</dt><dd' +
            ((Number(t.netDeltaRaw != null ? t.netDeltaRaw : t.rawBalance) < 0) ? ' class="err"' : '') + '>' +
            esc(fmtUi(t.netDeltaRaw != null ? t.netDeltaRaw : t.rawBalance, t.decimals)) + ' ' + esc(t.symbol) +
            ' <span class="note">(' + esc(t.netDeltaRaw != null ? t.netDeltaRaw : t.rawBalance) + ' base units)</span></dd>' +
          '<dt>scan vs live chain</dt><dd>' + (t.reconciles
            ? '<span class="verdict ok">reconciles</span>'
            : '<span class="err">mismatch — history outside scan window (on-chain now: ' + esc(fmtUi(t.onchainNow, t.decimals)) + ')</span>') + '</dd>' +
          '<dt>multiplier now</dt><dd>' + (t.excluded
            ? '<span class="err">excluded — ' + esc(t.excludedReason || 'timeline error') +
              ' (raw shown as stored; adjusted not computed)</span>'
            : esc(t.multiplier.now) + ' <span class="note">(' + esc(t.multiplier.events) + ' events)</span>') + '</dd>' +
          (noAdjusted
            ? '<dt>adjusted</dt><dd><span class="err">adjusted — not computed' +
              (t.excludedReason ? ' (' + esc(t.excludedReason) + ')' : '') + '</span></dd>'
            : '<dt>adjusted (exact)</dt><dd>' + esc(fmtUi(t.adjusted.whole, t.decimals)) +
              (t.adjusted.exact ? '' : ' + ' + esc(t.adjusted.remainder) + '/' + esc(t.adjusted.den) + ' base units') + '</dd>') +
          '<dt>open lots (FIFO)</dt><dd>' + t.lots.length +
            (t.realizedCount ? ', realized ' + t.realizedCount + ' disposals' : '') + '</dd>' +
          gaps + '</dl></div>';
      }).join('');
  el('wallet-out').innerHTML = head + body;
}

document.getElementById('scan-btn').onclick = scanWalletUi;
el('addr-in').onkeydown = function (e) { if (e.key === 'Enter') scanWalletUi(); };

fetch('/health').then(function (r) {
  if (!r.ok) throw new Error('/health HTTP ' + r.status); // 502-джейсон прокси — не «undefined tokens» (волна D1)
  return r.json();
}).then(function (h) {
  if (!h || typeof h !== 'object') throw new Error('/health: unexpected body');
  return fetch('/summary').then(function (r) {
    if (!r.ok) throw new Error('/summary HTTP ' + r.status);
    return r.json();
  }).then(function (list) {
    if (!Array.isArray(list)) throw new Error('/summary: unexpected body');
    state.tokens = list;
    renderStats(h, list);
    renderTokens(list);
    if (list.length) select(list[0].symbol); // самый событийный токен, без хардкода
  });
}).catch(function (e) {
  el('stats').innerHTML = '<div class="stat"><b class="err">API unavailable</b><i>' + esc(e.message) + ' — retry in a moment</i></div>';
});
</script>
</body>
</html>`;
}
