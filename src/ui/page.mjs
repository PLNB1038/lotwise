// Lotwise showcase: a single self-contained report page (a sample API consumer).
// No dependencies and no external resources: only relative fetches to its own API.
// The public side is English, no emojis, only verifiable facts from the endpoints.

// The favicon is the same L mark (assets/logo-mark.svg) but in a single accent #58a6ff:
// a data-URI has no CSS context of the page — there is nothing to inherit currentColor
// from, and the neutral ink (#e6edf0/#1f2328) vanishes on a light or dark tab bar.
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
  input[type=number], input[type=date], #token-filter, select {
    background: #0d1117; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-family: var(--mono); font-size: 14px;
  }
  #token-filter { width: 280px; margin: 0 0 8px; }
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
  /* the address stays on screen, the multiplier column is not cut
     off at the edge — on narrow screens it collapses (the value is in the token card),
     long numbers wrap instead of tearing the grid */
  @media (max-width: 640px) {
    main { padding: 16px 10px 48px; }
    .row { flex-direction: column; align-items: stretch; gap: 6px; }
    .row label { width: 100%; }
    #addr-in { width: 100%; }
    .kv { grid-template-columns: 1fr; }
    #token-table th:nth-child(5), #token-table td:nth-child(5) { display: none; }
    th, td { word-break: break-word; }
  }
</style>
</head>
<body>
<main>
  <header class="brand">
    <svg class="brand-mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false">
      <!-- the Lotwise mark (an L monogram, same as the favicon and README): the spine
           is the event axis, the accent leg is an adjusted lot, the dot on the spine is
           the event itself -->
      <rect x="4.5" y="4" width="4" height="24" rx="2" fill="currentColor"/>
      <rect x="4.5" y="24.5" width="21" height="3.5" rx="1.75" fill="#58a6ff" class="accent"/>
      <circle cx="6.5" cy="13" r="2.3" fill="#58a6ff" class="accent"/>
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

  <!-- Dividend layer: static editorial context (not data — data above and below comes
       from the API). Tickers are listed by name without counters so the copy cannot drift
       apart from the registry; the "no events yet" fact is anchored to the expansion date,
       not to the moment of reading. -->
  <section id="dividend-layer">
    <h2>Dividend layer</h2>
    <div class="card">
      <p>The event schema includes <code>DIVIDEND_ACCRUAL</code>: an issuer-declared amount per
        unit (exact raw integer and decimals), credited by the FIFO lot engine to every holder on
        the ex-date. Classic dividend payers from issuer Backed (xStocks) — JPMx (JPMorgan Chase),
        KOx (Coca-Cola), Vx (Visa), XOMx (Exxon Mobil), plus QQQx (Nasdaq-100 ETF), the ETF sibling
        of the tracked SPYx — joined the registry on Sep 22, 2026 (mints from the issuer API,
        verified on mainnet, Token-2022, 8 decimals). Their dividend history already flows through
        the pipeline as dated multiplier events — each accrual bumps the supply multiplier, every
        row carries its source link; per-unit amounts become accrual events the moment the issuer
        publishes declarations.</p>
    </div>
  </section>

  <section>
    <h2>Tracked tokens</h2>
    <input id="token-filter" placeholder="Filter by symbol or name" spellcheck="false" autocomplete="off">
    <table id="token-table">
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
        A first scan of an active wallet can take several minutes on public RPC.</p>
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

// Source-corruption banner (0|1 from /health, contract with the boot zone): falsy —
// silence, truthy — the same honest warn style as unavailable/excluded.
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
  // The RPC may have been down at startup: journal.unavailable — tokens not read from
  // the chain, and the showcase paints multiplier "1" for them. Silence = a quiet lie;
  // show an honest warn.
  if (h.journal && h.journal.unavailable > 0) {
    el('stats').innerHTML +=
      '<div class="stat"><b class="err">' + esc(h.journal.unavailable) + '</b>' +
      '<i>tokens unavailable at startup — multipliers may be understated</i></div>';
  }
  // Tokens excluded from the showcase over a broken timeline (health.excluded[] from the
  // server): a "1" row in the table without the mark is indistinguishable from an honest
  // "no events ever".
  if (h.excluded && h.excluded.length > 0) {
    el('stats').innerHTML +=
      '<div class="stat"><b class="err">' + esc(h.excluded.length) + '</b>' +
      '<i>tokens excluded from multiplier reporting — shown as excluded, not computed</i></div>';
  }
  // Source corruption at startup: the journal is corrupted (the backfill did not restore
  // everything), the evidence could not be preserved (the broken file could not be
  // renamed), the registry is corrupted. Silence = a quiet lie — the same class as
  // unavailable/excluded above.
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

function select(symbol, scroll) {
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
  // a token change clears the panels BEFORE loading : the previous token's
  // events/calc do not sit under the new title while its answers are in flight
  el('events').innerHTML = '<li class="note">loading events…</li>';
  el('calc-out').innerHTML = '';
  loadEvents(t);
  loadPlanes(t);
  calc();
  // auto-jumping on page load kicked the user off the first screen
  // (header + address field) down to the token table. Scrolling happens only on click.
  if (scroll !== false) document.getElementById('detail').scrollIntoView({ behavior: 'smooth' });
}

function eventsError(msg) {
  el('events').innerHTML = '<li><span class="what err">' + esc(msg) + '</span></li>';
}

// The key of a cross-check badge: event type + effectiveDate + the sequence number among
// the events of their OWN type. Keying by the date alone collided: two events on one day —
// and the first showed the second's verdict (the Map was overwritten); a rebase and a
// dividend on the same day would also clash on matching numbers — we separate them with
// the type prefix. /crosscheck serves verdicts in blocks in event order: all
// MULTIPLIER_CHANGE first, then DIVIDEND_ACCRUAL (the showcase contract), so the
// (type, seq) pair joins the two sides unambiguously.
function xcKey(e, seq) {
  return (e.type === 'DIVIDEND_ACCRUAL' ? 'div' : 'mult') + '#' + e.effectiveDate + '#' + seq;
}

function loadEvents(t) {
  fetch('/events?symbol=' + encodeURIComponent(t.symbol))
    .then(function (r) { return r.json().then(function (list) { return { ok: r.ok, status: r.status, list: list }; }); })
    .then(function (res) {
      if (state.selected !== t) return; // stale response: the user has already switched tokens
      // a non-array ({error} from a 500) is not "empty history": show the error, do not mask it
      if (!res.ok || !Array.isArray(res.list)) {
        eventsError('Event history unavailable (HTTP ' + res.status +
          (res.list && res.list.error ? ': ' + res.list.error : '') + ')');
        return;
      }
      renderEvents(res.list, null);
      if (!res.list.length) return;
      // price cross-check verdicts arrive in a second pass and enrich the timeline with badges
      fetch('/crosscheck?symbol=' + encodeURIComponent(t.symbol))
        .then(function (r) { return r.json(); })
        .then(function (xc) {
          if (state.selected !== t) return;
          var byKey = {};
          var vi = 0; // sequence number among MULTIPLIER_CHANGE
          var di = 0; // sequence number among DIVIDEND_ACCRUAL
          var numMult = 0;
          res.list.forEach(function (e) { if (e.type === 'MULTIPLIER_CHANGE') numMult += 1; });
          res.list.forEach(function (e) {
            var isMult = e.type === 'MULTIPLIER_CHANGE';
            if (!isMult && e.type !== 'DIVIDEND_ACCRUAL') return;
            // verdicts arrive in blocks: all rebases first (in event order), then all
            // dividends (in event order) — a verdict index = the event's position in its block
            var seq = isMult ? vi : di;
            var idx = isMult ? vi : numMult + di;
            if (isMult) vi += 1; else di += 1;
            if (xc.verdicts && xc.verdicts[idx]) byKey[xcKey(e, seq)] = xc.verdicts[idx];
          });
          renderEvents(res.list, byKey);
        })
        .catch(function () { /* badges are enrichment, not data: silently go without them */ });
    })
    .catch(function (e) {
      // network/server restart: without the catch — an unhandled rejection, and the OTHER
      // token's timeline stayed under the new title. An honest err note.
      if (state.selected !== t) return;
      eventsError('Event history unavailable: ' + e.message);
    });
}

// Signed price-drop fraction (drop semantics): a drop carries a minus, a rise a plus.
function pctDrop(f) { return (f < 0 ? '+' : '-') + (Math.abs(f) * 100).toFixed(3) + '%'; }

// Badge color — by verdict, the same class set as the rebase badge; its own label:
// "dividend: …" tells a dividend verdict apart from a rebase "price: …" at a glance.
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
  // the dividend comparison numbers go compactly into the tooltip, like the rebase's note:
  // the pre-ex price fractions are dimensionless — the verdict honestly has no dollars or FX
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
  var seqM = 0; // sequence among MULTIPLIER_CHANGE — the same one used to key verdicts
  var seqD = 0; // sequence among DIVIDEND_ACCRUAL — a dividend lives on its own row
  el('events').innerHTML = list.map(function (e) {
    var isMult = e.type === 'MULTIPLIER_CHANGE';
    var isDiv = e.type === 'DIVIDEND_ACCRUAL';
    var key = null;
    if (isMult) { key = xcKey(e, seqM); seqM += 1; }
    else if (isDiv) { key = xcKey(e, seqD); seqD += 1; }
    var title = isDiv ? 'dividend accrual' : (e.reason || e.type);
    // a dividend is not a multiplier change: instead of from → to, its own accrual amount
    // (raw → human by the event's decimals; unknown decimals — fmtUi will say so honestly)
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
      if (state.selected !== t) return; // stale response
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
      if (state.selected !== t) return; // someone else's error does not land on the new token 
      setVerdict('unavailable', 'unavailable');
      el('planes').innerHTML = '<dt>on-chain source</dt><dd class="err">' + esc(e.message) + '</dd>';
    });
}

var calcSeq = 0;
function calc() {
  var t = state.selected;
  var mySeq = ++calcSeq; // epoch: a stale recompute does not repaint 
  if (!t) return;
  var rawIn = (el('raw-in').value || '0').trim();
  if (!/^\\d*(\\.\\d*)?$/.test(rawIn) || rawIn === '' || rawIn === '.') {
    el('calc-out').innerHTML = '<dt>input</dt><dd class="err">enter a non-negative amount, e.g. 1.5</dd>';
    return;
  }
  // decimals null (registry before enrich-decimals): the UI number cannot honestly be
  // converted into base units — show the input as is, the calculator does not compute,
  // not inventing a 0
  if (t.decimals == null) {
    el('calc-out').innerHTML =
      '<dt>input</dt><dd>' + esc(rawIn) + '</dd>' +
      '<dt>decimals</dt><dd class="err">decimals unknown for this token — conversion skipped, not guessing</dd>';
    return;
  }
  // UI number -> integer base units as a string, no float magic
  var parts = rawIn.split('.');
  var base = parts[0] || '0';
  var frac = parts[1] || '';
  // precision beyond decimals is not expressible in base units — truncate and mark honestly
  var truncated = frac.length > t.decimals && frac.slice(t.decimals).replace(/0+$/, '') !== '';
  var padded = (frac + '0'.repeat(Math.max(0, t.decimals - frac.length))).slice(0, t.decimals);
  var raw = BigInt(base + padded);
  var qs = '/multiplier?symbol=' + encodeURIComponent(t.symbol) +
    '&raw=' + raw.toString() + '&date=' + encodeURIComponent(el('date-in').value || todayISO());
  fetch(qs)
    .then(function (r) { return r.json(); })
    .then(function (m) {
      if (mySeq !== calcSeq || state.selected !== t) return; // stale response (epoch)
      // an {error} body from a 400/500: json made it, the data did not — show the reason honestly
      if (m && m.error) {
        el('calc-out').innerHTML = '<dt>api</dt><dd class="err">' + esc(m.error) + '</dd>';
        return;
      }
      // a token without a timeline: a short response without sampleScaledQty — there is
      // nothing to compute adjusted from, and the "1" in the response is a default, not a
      // computation; show the caveat, not a TypeError
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
        // contractually-numeric fields get escaped too : a string in them
        // is off-contract, but silent stored XSS costs more than one esc() call
        '<dt>adjusted (base units)</dt><dd>' + esc(s.whole) + (s.exact ? '' : ' + ' + esc(s.remainder) + '/' + esc(s.den)) + '</dd>' +
        '<dt>remainder policy</dt><dd>' + dust + '</dd>' +
        (truncated ? '<dt>input precision</dt><dd class="err">amount exceeds ' + t.decimals + ' token decimals — truncated to base units</dd>' : '');
    })
    .catch(function (e) {
      if (mySeq !== calcSeq || state.selected !== t) return; // a stale attempt stays silent 
      el('calc-out').innerHTML = '<dt>api</dt><dd class="err">' + esc(e.message) + '</dd>';
    });
}

document.getElementById('calc').onclick = calc;
el('date-in').onchange = calc;
el('raw-in').onchange = calc;

// Live filter over the Tracked tokens table: no button, filtering happens on input.
// The haystack is symbol + name only (issuer and counters do not match by design);
// filtering only toggles row display — row onclick handlers and the selected class
// are untouched.
function applyTokenFilter() {
  var q = (el('token-filter').value || '').toLowerCase();
  document.querySelectorAll('#tokens tr').forEach(function (tr) {
    var hay = (tr.getAttribute('data-symbol') + ' ' + tr.children[1].textContent).toLowerCase();
    tr.style.display = hay.indexOf(q) !== -1 ? '' : 'none';
  });
}
el('token-filter').oninput = applyTokenFilter;

function fmtUi(rawStr, decimals) {
  var s = String(rawStr);
  var sign = '';
  if (s[0] === '-') { sign = '-'; s = s.slice(1); }
  // decimals null (registry before enrich-decimals): raw base units with a note,
  // not "." from slice(0, -null) — we do not invent zero decimals
  if (decimals == null) return sign + s + ' base units (decimals unknown)';
  if (decimals === 0) return sign + s;
  while (s.length <= decimals) s = '0' + s;
  return sign + s.slice(0, -decimals) + '.' + s.slice(-decimals);
}

// a bare "fetch failed" with no explanation scares people. A human phrase
// for the network class, the original in the tooltip (honesty kept, accessibility given).
function humanScanError(body, rawMsg) {
  var m = String(rawMsg || (body && body.error) || '');
  var kind = body && body.kind;
  if (kind === 'rate-limit' || /HTTP 429|rate limit/i.test(m)) {
    return 'Rate limit reached (public RPC) — wait a moment and scan again.';
  }
  if (kind === 'network' || /fetch failed|failed to fetch|network/i.test(m)) {
    return 'Solana RPC is unreachable right now — this demo runs on public infrastructure. Try again in a minute.';
  }
  return m || 'scan failed';
}

function scanWalletUi() {
  var addr = (el('addr-in').value || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) {
    el('wallet-out').innerHTML = '<p class="err">Enter a valid Solana address (base58).</p>';
    return;
  }
  var myAddr = addr; // capture the address: another scan's response must not be rendered
  // the button dims for the duration of the scan + an honest elapsed timer —
  // "Scanning…" used to sit there for minutes with no progress, and the button could
  // be clicked again.
  var btn = document.getElementById('scan-btn');
  btn.disabled = true;
  var started = Date.now();
  el('wallet-out').innerHTML =
    '<p class="note">Scanning wallet on-chain — an active wallet can take several minutes on public RPC. <span id="scan-elapsed">0s</span></p>';
  var tick = (typeof setInterval === 'function')
    ? setInterval(function () {
        var s = document.getElementById('scan-elapsed');
        if (s) s.textContent = Math.round((Date.now() - started) / 1000) + 's';
      }, 1000)
    : 0;
  var finish = function () {
    if (tick) clearInterval(tick);
    btn.disabled = false;
  };
  fetch('/lots?address=' + encodeURIComponent(addr))
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
    .then(function (res) {
      // Scan/Scan race: the user fixed the address while a long scan was running — the
      // late-arriving response of the old address does not overwrite the showcase (the
      // same guard class as state.selected for tokens)
      if ((el('addr-in').value || '').trim() !== myAddr) { finish(); return; }
      if (!res.ok) {
        finish();
        var orig = (res.body && res.body.error) || 'scan failed';
        el('wallet-out').innerHTML = '<p class="err" title="' + esc(orig) + '">' + esc(humanScanError(res.body)) + '</p>';
        return;
      }
      finish();
      renderWallet(res.body);
    })
    .catch(function (e) {
      // the same race for errors: blaming a failed request for another address is a lie
      if ((el('addr-in').value || '').trim() !== myAddr) { finish(); return; }
      finish();
      el('wallet-out').innerHTML = '<p class="err" title="' + esc(e.message) + '">' + esc(humanScanError(null, e.message)) + '</p>';
    });
}

function renderWallet(rep) {
  var c = rep.counts;
  // excluded tokens in the report: their multiplier is a default, adjusted was not computed
  var excludedCount = 0;
  rep.tokens.forEach(function (x) { if (x.excluded) excludedCount += 1; });
  // a full ISO timestamp reads hard — date + minutes UTC
  var when = String(rep.now || '—').replace('T', ' ').slice(0, 16) + (rep.now ? ' UTC' : '');
  // money legs the pricing did not consume — a round-trip spread (also one mixed with a
  // trade whose pricing was withdrawn), a USDC fee or transfer; the report does not guess
  // which. The net is shown per mint (mints are never merged); the full row list lives in
  // the tooltip. Shown only when the field is present: an older report renders as before.
  var moneyOnly = rep.moneyOnly || [];
  var moFull = moneyOnly.map(function (r) {
    return (r.date ? String(r.date).replace('T', ' ').slice(0, 16) + ' UTC — ' : '') +
      fmtUi(r.amountRaw, 6) + ' USDC  ' + r.signature;
  }).join('; ');
  var moNets = moneyOnly.reduce(function (acc, r) {
    acc[r.mint] = (acc[r.mint] === undefined ? 0n : acc[r.mint]) + BigInt(r.amountRaw);
    return acc;
  }, {});
  var moNetStr = Object.keys(moNets).map(function (mint) {
    return esc(fmtUi(String(moNets[mint]), 6)) + ' USDC';
  }).join(' + ');
  var moneyRow = moneyOnly.length
    ? '<dt>USDC not priced into a trade</dt><dd title="' + esc(moFull) + '">' + moneyOnly.length +
        ' tx, net ' + esc(moNetStr) +
        ' <span class="note">(a spread, a fee, a transfer — or an unattributable mixed trade; not in realized P&L)</span></dd>'
    : '';
  // completeness is withdrawn for four independent reasons — the card names EVERY active
  // one instead of the old hard-coded "has gaps", which lied about zero-gap reports
  var gapsTotal = 0, notReconciled = 0;
  rep.tokens.forEach(function (t) {
    if (t.gaps && t.gaps.length) gapsTotal += t.gaps.length;
    if (t.reconciles === false) notReconciled += 1;
  });
  var reasons = [];
  if (gapsTotal > 0) reasons.push('has gaps — lots may miss an opening balance');
  if (notReconciled > 0) reasons.push(notReconciled + ' token' + (notReconciled > 1 ? 's' : '') + ' did not reconcile with the chain — history outside the scan window');
  if (rep.ambiguousSlotPairs) reasons.push(rep.ambiguousSlotPairs + ' same-slot pair' + (rep.ambiguousSlotPairs > 1 ? 's' : '') + ' from different sources — ledger order guessed, history not certified');
  var completeness = rep.complete ? 'complete'
    : 'incomplete — ' + (reasons.length
        ? reasons.join('; ')
        : (rep.truncated ? 'truncated at cap (see scan window above)' : 'has gaps — lots may miss an opening balance'));
  var head = '<dl class="kv">' +
    '<dt>owner</dt><dd>' + esc(rep.owner) + '</dd>' +
    '<dt>report generated at</dt><dd>' + esc(when) + '</dd>' +
    '<dt>signatures scanned</dt><dd>' + esc(c.signatures) + ' (' + esc(c.fetched) + ' fetched, ' + esc(c.skipped) + ' skipped)</dd>' +
    '<dt>scan window</dt><dd>' + (rep.truncated ? 'truncated at cap — older history not scanned' : 'full history') + '</dd>' +
    '<dt>completeness</dt><dd' + (rep.complete ? '' : ' class="err"') + '>' + completeness +
      (excludedCount > 0 ? ' — ' + excludedCount + ' tokens excluded' : '') + '</dd>' +
    moneyRow + '</dl>';
  var body = rep.tokens.length === 0
    ? '<p class="note">No tracked tokens found in this wallet.</p>'
    : rep.tokens.map(function (t) {
        // adjusted was not computed: the token is excluded from multipliers (t.excluded) or
        // the API honestly reported adjustedAvailable:false (an excluded mint). The raw
        // fallback balance must not be shown as "adjusted (exact)" — the same quiet lie
        // of "adjusted = raw".
        var noAdjusted = t.excluded || t.adjustedAvailable === false;
        // a wall of gaps collapses to one line, the full list in the tooltip
        var gapsFull = t.gaps.map(function (g) {
          return g.missingQtyRaw + ' base units predate the scan window' + (g.date ? ' (by ' + String(g.date).replace('T', ' ').slice(0, 16) + ' UTC)' : '');
        }).join('; ');
        var gaps = t.gaps.length
          ? '<dt class="err">scan gap</dt><dd class="err" title="' + esc(gapsFull) + '">' + esc(t.gaps[0].missingQtyRaw) +
              ' base units predate the scan window' + (t.gaps.length > 1 ? ' +' + (t.gaps.length - 1) + ' more (hover)' : '') + '</dd>'
          : '';
        // the USDC leg of each trade prices the report (basis on buys, proceeds on
        // sells). basisKnown === undefined means an older cached report — such lots are neither
        // priced nor "unpriced", they render exactly as before.
        var lotsPriced = t.lots.filter(function (l) { return l.basisKnown === true; });
        var openBasis = lotsPriced.reduce(function (a, l) { return a + BigInt(l.basisRaw); }, 0n);
        var lotsUnknown = t.lots.filter(function (l) { return l.basisKnown === false; }).length;
        var realized = t.realized || [];
        var pricedDisposals = realized.filter(function (r) { return r.pnlRaw !== null && r.pnlRaw !== undefined; });
        var pnl = pricedDisposals.reduce(function (a, r) { return a + BigInt(r.pnlRaw); }, 0n);
        var proceeds = realized.filter(function (r) { return r.proceedsKnown === true; })
          .reduce(function (a, r) { return a + BigInt(r.proceedsRaw); }, 0n);
        var unpriced = realized.length - pricedDisposals.length;
        var lotsRow = '<dt>open lots (FIFO)</dt><dd>' + t.lots.length +
          (openBasis > 0n ? ', basis ' + esc(fmtUi(String(openBasis), 6)) + ' USDC' : '') +
          (lotsUnknown > 0 ? ' <span class="note">(' + lotsUnknown + ' lot' + (lotsUnknown > 1 ? 's' : '') + ' unpriced — bought without a USDC leg)</span>' : '') +
          (t.realized ? '' : (t.realizedCount ? ', realized ' + t.realizedCount + ' disposals' : '')) + '</dd>';
        var proceedsOnly = realized.filter(function (r) { return r.proceedsKnown === true && r.pnlRaw === null && r.pnlRaw !== undefined; });
        var proceedsOnlySum = proceedsOnly.reduce(function (a, r) { return a + BigInt(r.proceedsRaw); }, 0n);
        var pnlRow = realized.length
          ? '<dt>realized P&L (USDC)</dt><dd>' + (pricedDisposals.length
              ? '<span class="' + (pnl >= 0n ? 'verdict ok' : 'err') + '">' + esc(fmtUi(String(pnl), 6)) + '</span>' +
                ' <span class="note">proceeds ' + esc(fmtUi(String(proceeds), 6)) +
                (unpriced > 0 ? ', ' + unpriced + ' disposal' + (unpriced > 1 ? 's' : '') + ' unpriced' : '') + '</span>'
              : proceedsOnly.length
                // the sale HAD a USDC leg — its proceeds are money the wallet
                // really received; only the cost side is unknown. That is not "no leg".
                ? '<span class="note">proceeds ' + esc(fmtUi(String(proceedsOnlySum), 6)) + ' USDC booked on ' +
                  proceedsOnly.length + ' disposal' + (proceedsOnly.length > 1 ? 's' : '') +
                  ' — basis unknown (bought without a USDC leg), P&L not computed</span>'
          : '<span class="note">no priced disposals — ' + (moneyOnly.length
              ? 'the USDC leg did not price this trade (see the USDC rows above)'
              : 'the sales had no USDC leg') + '</span>') + '</dd>'
          : '';
        return '<div class="card"><h3>' + esc(t.symbol) + ' — ' + esc(t.name) + '</h3><dl class="kv">' +
          '<dt>' + (t.reconciles ? 'raw balance (reconciles with chain)' : 'net delta of scan window — not an on-chain balance') + '</dt><dd>' +
            // a negative window delta is NOT an error but an artifact of the scan
            // window: in red it read as "you have a problem"; the explanation lives in the label
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
          lotsRow + pnlRow + gaps + '</dl></div>';
      }).join('');
  el('wallet-out').innerHTML = head + body;
}

document.getElementById('scan-btn').onclick = scanWalletUi;
el('addr-in').onkeydown = function (e) { if (e.key === 'Enter') scanWalletUi(); };

fetch('/health').then(function (r) {
  if (!r.ok) throw new Error('/health HTTP ' + r.status); // a proxy's 502 JSON — not "undefined tokens" 
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
    if (list.length) select(list[0].symbol, false); // the most eventful token, no hardcoding and NO auto-jump 
  });
}).catch(function (e) {
  el('stats').innerHTML = '<div class="stat"><b class="err">API unavailable</b><i>' + esc(e.message) + ' — retry in a moment</i></div>';
});
</script>
</body>
</html>`;
}
