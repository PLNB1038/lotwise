# Источники корпоративных событий по эмитентам

Исследовано 18.09.2026 вечером (ночь спринта). Отметки: ✅ = проверено живым запросом,
📄 = прочитана страница, ❓ = вторичный источник, не проверен.

## Backed / xStocks — ЗОЛОТОЙ ИСТОЧНИК

Модель: корпоративные события отражаются через **multiplier** (on-chain rebasing-механизм).
Raw-баланс на Solana НЕ меняется; displayed = raw × multiplier.

- Типы событий: **DVCA** (дивиденд, реинвестируется → множитель растёт), **SPLF** (сплит),
  **SPLR** (обратный сплит). 📄 docs.xstocks.fi/developers/multipliers
- Множитель публикуется on-chain ЗАРАНЕЕ, активация 00:30 UTC дня после Ex-date. 📄
- On-chain (Solana): **Scaled UI Amount Extension** (SPL Token-2022) — множитель лежит
  в метаданных токена, читается `getAccountInfo`. 📄 (солскан-пример в доках)
- **API (публичный, без ключа):** ✅
  - Текущий: `GET https://api.xstocks.fi/api/v2/public/assets/{SYMBOL}/multiplier?network=Solana`
    → `{currentMultiplier, newMultiplier, activationDateTime, reason}`
  - История: `GET .../assets/{SYMBOL}/multiplier/history?page=0&pageSize=10&network=Solana`
  - Метаданные актива: `GET .../assets/{SYMBOL}?network=Solana` ✅ (ISIN, торговые часы, halted)
  - Webhook-иvents «forthcoming» (поллинг пока единственный путь). 📄
- **ЖИВАЯ ВАЛИДАЦИЯ 18.09:** ✅ SPYx `currentMultiplier = 1.005714560286254` — уже ≠ 1.0,
  т.е. ЛЮБОЙ P&L по raw-балансам для SPYx уже сейчас врёт. TSLAx history на Solana пуста (событий ещё не было).

Следствие для Lotwise: у xStocks ДВА независимых плана источника (API-история множителей +
on-chain ScaledUI-метаданные) — идеально для fail-closed reconcile.

⚠️ Нюанс схемы: множитель — float (накопительный). Наша схема — целочисленные коэффициенты.
Нужен третий тип представления: событие MULTIPLIER_CHANGE (from/to, активация) поверх
raw-слоя, а SPLIT-подобная интерпретация — на scaled-слое. Запланировать эволюцию схемы.

## PreStocks

Модель: SPV приобретают pre-IPO доли, токены = пропорциональные интересы SPV (Reg S). ❓
- Событийный аналог: переоценки (valuation marks) листингов, новые листинги/делистинги.
- Официальных публичных API событий НЕ найдено (18.09); основной канал — сайт/анонсы/соцсети. ❓
- On-chain: минты/листинги видны (мы уже находили трейдеров через сигнатуры минта в цикле StockBasis). ✅ (наш опыт)
- Стратегия MVP: события = наши on-chain наблюдения (масс-минт/листинг) + ручная кураторская
  запись; официальный канал уточнить письмом/дискордом (задача недели 2).

## Tessera (T-токены)

Модель: T-токен = loan participation right (не ценная бумага!): заём issue-субсидиярам Tessera
Works Foundation. Доки: docs.tessera.pe (GitBook, есть llms.txt — удобно для автоматизации). ✅
- Релевантные разделы: Token System & Fees, Auction, Trade, **Redemption** (→ наш REDEEM),
  Proof-of-Reserve, On-Chain Programs. ✅ (структура прочитана)
- Событийный аналог: изменения фи/аукционов, redemption-окна, переоценки обеспечения.
- Публичного events-API не видно; PoR и программы on-chain — читаемые источники для сверок.

## Backpack Securities (MSTR/DELL/WEN/DKNG)

Четвёртая семья токенов в нашем реестре. Источники событий не исследованы (не MVP-критично,
4 токена). Задача: найти доки Backpack по своим security-токенам (неделя 2).

## Рекомендация MVP

1. xStocks — первоклассный приоритет: multiplier history API + on-chain ScaledUI = полный
   автоматический цикл (события уже происходили: SPYx).
2. Tessera — Redemption/Fees из доков + on-chain программы; события ручные/полуавтоматические.
3. PreStocks — on-chain + куратор; API нет.
4. Backpack Securities — отложено.
