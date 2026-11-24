# @red-cup-engineering/strategy-tournament-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Runs a deterministic strategy tournament over one daily OHLCV series: builds
baseline and external target-weight entries, replays each over purged
walk-forward train/validation/holdout segments through the Group
transaction-cost replay, selects on validation-only evidence, and reports
untouched holdout for every entry.

## Operation

```js
runStrategyTournament(request: {
  bars: {t: string, o: number, h: number, l: number, c: number, v: number}[],
  entries?: {id: string, targetWeights: number[]}[],
  costModelBps?: number,
  folds?: {train: number, validation: number, holdout: number, purge: number},
  params?: {smaFast: number, smaSlow: number, macd: [number, number, number], zmrWindow: number, zmrEntryZ: number, zmrExitZ: number},
  policy?: {metric: string, direction: "maximize"|"minimize", maximumHoldoutDrawdown: number},
}): StrategyTournamentRecord
```

### Parameters

- `bars`: ascending daily OHLCV observations.
- `entries`: external target-weight series, index-aligned with `bars`, scored alongside the built-in baselines.
- `costModelBps`: linear transaction cost in basis points; defaults to 5.
- `folds`: fold sizing in bars; defaults sized for multi-year daily history (`{train: 504, validation: 126, holdout: 126, purge: 5}`).
- `params`: strategy parameters; defaults `{smaFast: 50, smaSlow: 200, macd: [12, 26, 9], zmrWindow: 20, zmrEntryZ: 2, zmrExitZ: 0.5}`.
- `policy`: validation-only selection policy passed to `selectModelCandidate`; defaults to maximizing `annualizedSharpe` with no drawdown cap.

### Returns

A frozen `StrategyTournamentRecord`: `{id, type, version, inputsDigest, params, folds, entries, selected, holdout}`. `entries[]` carries `{id, authorActor, train, validation, holdout}`, each segment `{cagr, annualizedSharpe, sortino, maxDrawdown, turnover, hitRate}` (`maxDrawdown` signed negative; `turnover` excludes the segment's initial position-funding trade). `selected` is the untouched `selectModelCandidate` result (validation-only ranking plus untouched holdout). `holdout` maps every entry id to its holdout measures. The same input always produces the identical `id`.

### Refusals

- `TypeError`: `bars` is not an array of at least two strictly ascending, finite OHLCV observations.
- `TypeError`: an external entry's `id` is missing or its `targetWeights` is not index-aligned with `bars`.
- `TypeError`: the requested `folds` are too short for `bars` (`bars.length <= folds.train + folds.purge + 2`), or `folds.train < 3`.

## Command

`run-strategy-tournament` reads one JSON request object on stdin, writes one `StrategyTournamentRecord` JSON object on stdout, and exits 2 with a `{error}` datum on stderr on refusal (including malformed JSON).

```sh
node scripts/run-strategy-tournament.mjs < request.json > record.json
```

## Built-in entries

Each a deterministic, causal target-weight series in `{0,1}` (long/flat) over `bars`:

- `buy-and-hold`: always long.
- `sma-cross`: long while the `smaFast`-period simple moving average is above the `smaSlow`-period one.
- `macd`: long while the MACD line is above its signal line. Reuses `@red-cup-engineering/technical-analysis-feature-measurement-service`'s `measureTechnicalAnalysisFeatures` (fixed at MACD(12,26,9)) when `params.macd` matches that default; computes the EMA difference directly otherwise, since no published Group primitive exposes a parameterized MACD.
- `zmr-mean-reversion`: enters long when the close's rolling z-score falls to or below `-zmrEntryZ`, exits when it rises to or above `-zmrExitZ` (hysteresis). Reuses the same service's `bollingerZ20` when `params.zmrWindow` is the default 20; computes the rolling z-score directly otherwise.

## Reuse

Composes published Group primitives rather than re-authoring their math:
`@red-cup-engineering/purged-walk-forward-fold-service` (`formPurgedWalkForwardFolds`) for the train/validation/holdout fold boundaries and label purge; `@red-cup-engineering/transaction-cost-replay-service` (`replayTransactionCosts`) for cost-aware equity, drawdown, turnover, and hit-rate math; `@red-cup-engineering/model-tournament-service` (`selectModelCandidate`) for validation-only selection with untouched holdout; `@red-cup-engineering/semantic-content-identify-service` (`identifyJsonSemanticContent`) for the record's content-addressed `id`/`inputsDigest`. `sma-cross` and the non-default MACD/ZMR paths compute their own windowed mean/EMA/z-score arithmetic directly, since no published Group package exposes a parameterized simple moving average or rolling z-score at an arbitrary window.

## Test fixture

`test/fixtures/btc-365d-coingecko.json` is a real recorded 365-day BTC/USD
daily price/volume series (see the sidecar `.meta.json` for provenance and
sha256). Stooq's free CSV endpoint now serves a client-side proof-of-work
anti-bot challenge instead of CSV data, so the test reuses the largest real
daily series already on disk under `alpaca-services-section`
(`signal-fusion-alpha-engine-service/test/fixtures/btc-365d-coingecko.json`)
rather than synthesizing prices. The fixture records one price per day, so
the test sets open/high/low/close to that single real recorded price.
