# Съёмка: как эксплореры/трекеры/DEX обращаются с множителем SPACEX (×5 с 10.06.2026)

Дата: 19.09.2026 Подопытный: Ho5371Kc1Kxy7ze85UYzZ4BUfSkLg39Xp3B424RuYrbC
(SPACEX-трейдер, 119 транзакций ДО активации x5 и сделки после).
Эталон: raw на цепи = 0.14847064 SPACEX; экономически (x5) = 0.7423532.

## Главная находка: RPC говорит на двух языках

Один и тот же эндпоинт (Helius mainnet), одни и те же токен-аккаунты:

| Вопрос | Метод | Ответ | Единицы |
|---|---|---|---|
| «Сколько у меня сейчас?» | getTokenAccountsByOwner | uiAmountString = **0.7423532** | экономические (raw x текущий множитель) |
| «Что происходило в сделке 16.09?» | getTransaction | uiAmountString = **0.14847064** (== raw) | сырые |
| «Что происходило в сделке 28.05 (до x5)?» | getTransaction | uiAmountString = **1.031989124** (== raw) | сырые |

Tx-запрос НИКОГДА не применяет множитель (проверено на сделках до и после активации),
балансовый — применяет всегда текущий. Итог: любой PnL-движок, который берёт историю
сделок из getTransaction (а иначе историю не достать), а текущую позицию из
балансовых запросов (а иначе баланс не достать), смешивает ДВЕ системы единиц,
расходящиеся ровно на исторический дрейф множителя. Без таймлайна множителя
на каждую дату эту смесь не привести к одному знаменателю. Это и делает Lotwise.

Дизайн подтверждён доками xStocks: «кошельки считают отображаемое значение
умножением on-chain баланса на текущий множитель» (docs.xstocks.fi).

## Съёмка по потребителям

| Потребитель | Что делает | Вердикт |
|---|---|---|
| Jupiter (DEX/цены) | price API отдаёт scaledUiConfig (multiplier 1 -> newMultiplier 5, дата активации, supply); котировка 12 USDC вернула 19346753 raw = **0.0967 scaled** — торгует в экономических единицах | осведомлён, корректен |
| Кошельки на uiAmountString (Phantom-класс) | балансовый запрос, поле уже умножено | спот-баланс корректен |
| PnL/трекеры на getTransaction | история в raw всегда | смесь единиц = ложь на дрейф множителя |
| Helius DAS (getAssetByOwner/searchAssets) | в нашей пробе активы кошелька не вернулись (0 items, total: none) — класс DAS-трекеров, похоже, слеп к этим токенам; требует перепроверки параметрами | под вопросом |
| solana.fm / solscan / sonar.watch | SPA/CF — автосъёмка не прошла; ручная сверка ниже | не проверено |
| Налоговые/PnL для xStocks | не существует: корпус 5400+ сабмитов Colosseum + выдача | пустая ниша |

## Ручная сверка (30 секунд, критерий: SPACEX показывает 0.742 или 0.148)

- https://solana.fm/address/Ho5371Kc1Kxy7ze85UYzZ4BUfSkLg39Xp3B424RuYrbC/tokens
- https://solscan.io/account/Ho5371Kc1Kxy7ze85UYzZ4BUfSkLg39Xp3B424RuYrbC#tokens
- https://explorer.solana.com/address/Ho5371Kc1Kxy7ze85UYzZ4BUfSkLg39Xp3B424RuYrbC/tokens

0.7423532 = масштабировал (ок). 0.14847064 = сырые (ложь x5). Нет строки = не видит токен.

## Формулировка для обсуждения

«Спот-балансы у хороших кошельков уже правильные — Scaled UI делает это бесплатно,
и Jupiter торгует в экономических единицах. Но RPC двуязычен: история транзакций
всегда в raw, баланс — всегда в scaled. Любой P&L, собранный из этих двух видов
запросов, смешивает единицы и врёт ровно на дрейф множителя. Для честной истории
нужен таймлайн множителя на каждую дату — его не отдаёт ни RPC, ни эмитент
(у PreStocks вообще только минт). Это и есть Lotwise.»

## Метод и пруфы

- Баланс: getTokenAccountsByOwner -> amount 148470640, uiAmountString 0.7423532 (decimals 9).
- Tx до активации (28.05.2026 17:17 UTC): 3GrGjmhE4Sr7bVER5Vso4vXSyxMWdZ8PXbBqmgJEqwy7wqauWn47cxdtLckwrTrx1beFAFfjDzryLDFgtf4ZJJPR — ui == raw.
- Tx после активации (16.09.2026 19:49 UTC): 2UYpKLqKvPFdnvzAHZkgY5mFfWvMgNV3HZ9m5S9MKLNkpeFq8xQNJJVpVnbxoiYGLW7MnQMKSRqxKBPgGfGT1QST — ui == raw (PRE 0.31127064 == raw; при балансовом запросе тот же аккаунт = x5).
- Jupiter: lite-api.jup.ag/price/v3 -> scaledUiConfig в ответе; quote 12 USDC -> outAmount 19346753 raw = 0.0967 scaled.
- Доки: docs.xstocks.fi (dividends & splits), solana.com (xStocks: Tokenizing Equities on Solana).
- Ограничение: проверено на Helius; поведение tx-views на других эндпоинтах не снималось.
