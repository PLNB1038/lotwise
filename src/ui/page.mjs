// Витрина Lotwise: одна самодостаточная страница-отчёт (sample consumer API).
// Без зависимостей и внешних ресурсов: только относительные fetch к своему же API.
// Публичная сторона — английский, без эмодзи, только проверяемые факты из эндпоинтов.

export function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lotwise — corporate actions for tokenized equities</title>
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
  <h1><span>Lotwise</span> — corporate actions for tokenized equities</h1>
  <p class="tagline">Dividends and splits of tokenized stocks (xStocks, PreStocks, Tessera) reach Solana
    as on-chain multiplier changes. The raw balance stays the same while the economic value shifts —
    so any report computed from raw transfers quietly drifts from reality. Lotwise normalizes issuer
    and on-chain data planes into one event stream and computes adjusted positions.</p>

  <div class="stats" id="stats"></div>

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
    <code>/health</code> <code>/tokens</code> <code>/events</code> <code>/multiplier</code> <code>/summary</code> <code>/onchain</code> <code>/lots</code> <code>/crosscheck</code>.
    All numbers come from the endpoints above — nothing is hardcoded in this page.
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

function renderStats(h, tokens) {
  var issuers = {};
  tokens.forEach(function (t) { issuers[t.issuer] = true; });
  el('stats').innerHTML =
    '<div class="stat"><b>' + h.tokens + '</b><i>tokens tracked</i></div>' +
    '<div class="stat"><b>' + h.events + '</b><i>events normalized</i></div>' +
    '<div class="stat"><b>' + Object.keys(issuers).length + '</b><i>issuers</i></div>' +
    '<div class="stat"><b>fail-closed</b><i>reconcile policy</i></div>';
}

function renderTokens(list) {
  el('tokens').innerHTML = list.map(function (t) {
    return '<tr data-symbol="' + esc(t.symbol) + '">' +
      '<td>' + esc(t.symbol) + '</td>' +
      '<td>' + esc(t.name) + '</td>' +
      '<td><span class="badge">' + esc(t.issuer) + '</span></td>' +
      '<td class="num">' + t.events + '</td>' +
      '<td class="num">' + esc(fmtMul(t.currentMultiplier)) + '</td></tr>';
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
  loadEvents(t);
  loadPlanes(t);
  calc();
  document.getElementById('detail').scrollIntoView({ behavior: 'smooth' });
}

function loadEvents(t) {
  fetch('/events?symbol=' + encodeURIComponent(t.symbol))
    .then(function (r) { return r.json(); })
    .then(function (list) {
      if (state.selected !== t) return; // устаревший ответ: пользователь уже переключил токен
      renderEvents(list, null);
      if (!list.length) return;
      // вердикты кросс-чека цены приходят вторым заходом и дополняют таймлайн бейджами
      fetch('/crosscheck?symbol=' + encodeURIComponent(t.symbol))
        .then(function (r) { return r.json(); })
        .then(function (xc) {
          if (state.selected !== t) return;
          var byDate = {};
          (xc.verdicts || []).forEach(function (v) { byDate[v.effectiveDate] = v; });
          renderEvents(list, byDate);
        })
        .catch(function () { /* бейджи — обогащение, не данные: молча без них */ });
    });
}

function xcBadge(v) {
  if (!v) return '';
  var map = {
    consistent: ['ok', 'price: consistent'],
    mismatch: ['disagree', 'price: mismatch'],
    suspicious: ['disagree', 'price: suspicious'],
    inconclusive: ['unavailable', 'price: inconclusive'],
    'no-price-data': ['unavailable', 'price: no data'],
  };
  var m = map[v.verdict] || ['unavailable', 'price: ?'];
  return ' <span class="verdict ' + m[0] + '" title="' + esc(v.note || '') + '">' + m[1] + '</span>';
}

function renderEvents(list, xcByDate) {
  if (!list.length) {
    el('events').innerHTML = '<li><span class="what">No normalized events for this token yet.</span></li>';
    return;
  }
  el('events').innerHTML = list.map(function (e) {
    return '<li><div class="when">' + esc(e.effectiveDate) + ' — ' + esc(e.reason || e.type) +
      xcBadge(xcByDate ? xcByDate[e.effectiveDate] : null) + '</div>' +
      '<div class="what">' + esc(e.multiplierFrom || '-') + ' &rarr; ' + esc(e.multiplierTo || '-') + '</div></li>';
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
      setVerdict('unavailable', 'unavailable');
      el('planes').innerHTML = '<dt>on-chain source</dt><dd class="err">' + esc(e.message) + '</dd>';
    });
}

function calc() {
  var t = state.selected;
  if (!t) return;
  var rawIn = (el('raw-in').value || '0').trim();
  if (!/^\\d*(\\.\\d*)?$/.test(rawIn) || rawIn === '' || rawIn === '.') {
    el('calc-out').innerHTML = '<dt>input</dt><dd class="err">enter a non-negative amount, e.g. 1.5</dd>';
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
      if (state.selected !== t) return; // устаревший ответ
      var s = m.sampleScaledQty;
      var dust = s.exact ? 'no dust — division is exact' : 'dust shown exactly: remainder ' + s.remainder + '/' + s.den + ' base units';
      el('calc-out').innerHTML =
        '<dt>raw (base units)</dt><dd>' + raw.toString() + '</dd>' +
        '<dt>multiplier at ' + esc(m.date.slice(0, 10)) + '</dt><dd>' + esc(m.multiplier) + '</dd>' +
        '<dt>adjusted (base units)</dt><dd>' + s.whole + (s.exact ? '' : ' + ' + s.remainder + '/' + s.den) + '</dd>' +
        '<dt>remainder policy</dt><dd>' + dust + '</dd>' +
        (truncated ? '<dt>input precision</dt><dd class="err">amount exceeds ' + t.decimals + ' token decimals — truncated to base units</dd>' : '');
    })
    .catch(function (e) {
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
  el('wallet-out').innerHTML = '<p class="note">Scanning wallet on-chain — first scan of an active wallet can take up to a minute.</p>';
  fetch('/lots?address=' + encodeURIComponent(addr))
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
    .then(function (res) {
      if (!res.ok) {
        el('wallet-out').innerHTML = '<p class="err">' + esc(res.body.error || 'scan failed') + '</p>';
        return;
      }
      renderWallet(res.body);
    })
    .catch(function (e) {
      el('wallet-out').innerHTML = '<p class="err">' + esc(e.message) + '</p>';
    });
}

function renderWallet(rep) {
  var c = rep.counts;
  var head = '<dl class="kv">' +
    '<dt>signatures scanned</dt><dd>' + c.signatures + ' (' + c.fetched + ' fetched, ' + c.skipped + ' skipped)</dd>' +
    '<dt>scan window</dt><dd>' + (rep.truncated ? 'truncated at cap — older history not scanned' : 'full history') + '</dd>' +
    '<dt>completeness</dt><dd' + (rep.complete ? '' : ' class="err"') + '>' +
      (rep.complete ? 'complete' : 'has gaps — lots may miss an opening balance') + '</dd></dl>';
  var body = rep.tokens.length === 0
    ? '<p class="note">No tracked tokens found in this wallet.</p>'
    : rep.tokens.map(function (t) {
        var gaps = t.gaps.length
          ? '<dt class="err">scan gap</dt><dd class="err">' + t.gaps.map(function (g) {
              return esc(g.missingQtyRaw) + ' base units predate the scan window' + (g.date ? ' (by ' + esc(g.date) + ')' : '');
            }).join('; ') + '</dd>'
          : '';
        return '<div class="card"><h3>' + esc(t.symbol) + ' — ' + esc(t.name) + '</h3><dl class="kv">' +
          '<dt>raw balance (on-chain)</dt><dd>' + esc(fmtUi(t.rawBalance, t.decimals)) + ' ' + esc(t.symbol) +
            ' <span class="note">(' + esc(t.rawBalance) + ' base units)</span></dd>' +
          '<dt>scan vs live chain</dt><dd>' + (t.reconciles
            ? '<span class="verdict ok">reconciles</span>'
            : '<span class="err">mismatch — history outside scan window (on-chain now: ' + esc(fmtUi(t.onchainNow, t.decimals)) + ')</span>') + '</dd>' +
          '<dt>multiplier now</dt><dd>' + esc(t.multiplier.now) + ' <span class="note">(' + t.multiplier.events + ' events)</span></dd>' +
          '<dt>adjusted (exact)</dt><dd>' + esc(fmtUi(t.adjusted.whole, t.decimals)) +
            (t.adjusted.exact ? '' : ' + ' + esc(t.adjusted.remainder) + '/' + esc(t.adjusted.den) + ' base units') + '</dd>' +
          '<dt>open lots (FIFO)</dt><dd>' + t.lots.length +
            (t.realizedCount ? ', realized ' + t.realizedCount + ' disposals' : '') + '</dd>' +
          gaps + '</dl></div>';
      }).join('');
  el('wallet-out').innerHTML = head + body;
}

document.getElementById('scan-btn').onclick = scanWalletUi;
el('addr-in').onkeydown = function (e) { if (e.key === 'Enter') scanWalletUi(); };

fetch('/health').then(function (r) { return r.json(); }).then(function (h) {
  return fetch('/summary').then(function (r) { return r.json(); }).then(function (list) {
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
