# Источники цен для токенизированных акций Solana

Исследовано 18.09.2026. ✅ = проверено живым запросом, ❓ = вторичный источник.

## Jupiter Price API v3 (lite) — PRIMARY ✅

`GET https://lite-api.jup.ag/price/v3?ids={mint}` — без ключа.

Проверено на TSLAx (`XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB`) 18.09: ✅
```json
{ "usdPrice": 364.28, "liquidity": 1_249_407, "decimals": 8,
  "priceChange24h": -0.0042, "blockId": 448190898,
  "stockData": { "price": 364.14, "mcap": 1.446T } }
```
- Бонусы: отдаёт `decimals` (закрывает null в нашем реестре!) и `stockData` с ценой
  underlying-акции — готовый кросс-чек токен vs акция.
- Лимиты lite-эндпоинта вежливые, ключ не нужен; при росте нагрузки — платный api.jup.ag.

## xStocks Assets API — NAV/метаданные ✅

`GET https://api.xstocks.fi/api/v2/public/assets/{SYMBOL}?network=Solana` — ISIN, underlying,
торговые часы (TwentyFourFive), isTradingHalted, текущий период (regular/extended).
Применение: гейтинг событий по торговым окнам underlying + эталонная цена эмитента.
(Цену как таковую этот эндпоинт не отдаёт — см. их /markets или Jupiter.)

## CoinGecko — исторические цены ❓→частично✅

- Tessera-токены листингованы: страницы «SpaceX (Tessera Pre-IPO)» (TSPACEX) и
  «OpenAI (Tessera Pre-IPO)» (TOPENAI) существуют ❓(страницы найдены поиском 18.09).
- Бесплатный tier: ~10-30 req/min с IP, исторические данные ограничены (30 дней глубины
  на free). Полезен как secondary для витрины.

## Pyth ❓

Прайс-фиды на xStocks/Tessera не подтверждены (не искал по каталогу — задача недели 2).
Если есть — это бы дал spot без keyed API.

## Дефолтная связка MVP

- **Spot для витрины/кросс-чеков:** Jupiter v3 (primary) + CoinGecko (fallback).
- **История вокруг дат событий:** Jupiter отдаёт текущий блок/цену; исторические свечи —
  через их price-history или DexScreener/GeckoTerminal OHLCV ❓(проверить на неделе 2).
- **Эталон underlying:** `stockData.price` из Jupiter + xStocks assets API (halted/часы).
- Вежливость: один общий throttle-клиент (наш RpcClient паттерн) для всех внешних HTTP.
