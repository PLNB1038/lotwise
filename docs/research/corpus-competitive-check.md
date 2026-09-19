# Конкурентная проверка по официальному корпусу Colosseum

Метод: Colosseum Copilot API (PAT, 19.09.2026 ~00:30), POST /search/projects —
корпус 5,400+ сабмитов всех хакатонов (Renaissance, Radar, Breakout, Cypherpunk).
Similarity — гибридный RRF-скор; важно относительное сравнение внутри выдачи.

## Запросы и результаты

| Запрос | Прямых конкурентов | Ближайшее (sim) |
|---|---|---|
| «corporate actions dividends splits tokenized equities / tax lot accounting engine» | **0 результатов** | — |
| «portfolio P&L tracker tax reports Solana wallets» | нет | Memefolio 0.052 (мемкоин-P&L), Flexanon 0.074 (аноним-портфелио) |
| «xStocks Backed tokens multiplier rebasing» | нет | Amberium 0.051, xVaultFi 0.032 (лендинг под xStocks) |
| «adjusted cost basis crypto tax lot accounting» | нет | Wag Street Gains 0.058 (крипто-гейнс), LedgerX 0.056 (мульти-кошёльковый учёт) |
| «dividend tracking RWA tokenized stocks holders» | нет | Reflection 0.073 (синтетика RWA), Buybak 0.072 (кэшбэк фракц. акциями) |
| «crypto tax reporting portfolio analytics API» | нет | Wag Street Gains 0.055, SolSync 0.049 (трекер) |

## Вывод: FULL GAP (подтверждено корпусом)

За всю историю Colosseum-хакатонов **ни один проект не делал корпоративные события /
adjusted lots / событийный учёт для токенизированных акций**. Соседние кластеры:

1. **Дженерик-криптоучёт** (Wag Street Gains, LedgerX, Ledger AI) — свопы/гейнс,
   ни слова про equity-события, Token-2022, множители.
2. **Токенизация акций** (Ramelax, Shift Stocks, Spout, Buybak, Reflection) — эмитенты,
   торговля, реварды; кластер «токенизация» ЖИВОЙ (crowdedness 204 — внимание рынка есть),
   но инфраструктуры событий в нём нет.
3. **Смежное**: xVaultFi — лендинг под xStocks (ещё одно доказательство зрелости класса активов).

Формулировка для питча: «толпа строит токенизированные акции и трекеры мемкоинов;
слой корпоративных событий между ними — пуст, и мы закрываем его» (по корпусу 5,400+
официальных сабмитов Colosseum, проверено 19.09.2026).

## Архивные материалы для питча (sim > 0.55)

- «xStocks: Tokenizing Equities on Solana» (solana_news)
- «Modernizing markets for a tokenized future» (a16z crypto)
- «Global DeFi Capital» (superteam_blog)
- «Introducing Tokenized GLXY» (galaxy_research)
- «Internet Capital Markets» (helius_blog)

## Хвосты

- Повторить проверку перед сабмитом (корпус CWF пополнится конкурентами).
- Архивные доки прочитать выборочно для цитат в Full Description.
- Токен в Chein/lotwise/.env (gitignored), до 17.12.2026.
