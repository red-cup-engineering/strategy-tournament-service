import { EMPTY_WITNESS_ROOT, identifyJsonSemanticContent } from "@red-cup-engineering/computer-content-address-engineering-services-section/semantic-content-identity";
import { measureTechnicalAnalysisFeatures } from "@red-cup-engineering/alpaca-services-section/technical-analysis-feature-measure";
import { replayTransactionCosts } from "@red-cup-engineering/transaction-cost-replay-service";
import { formPurgedWalkForwardFolds } from "@red-cup-engineering/purged-walk-forward-fold-service";
import { selectModelCandidate } from "@red-cup-engineering/model-tournament-service";

const INSTRUMENT_KEY = "instrument";
const REUSED_FEATURE_FLOOR_INDEX = 60;
const DEFAULT_MACD_PERIODS = Object.freeze([12, 26, 9]);
const DEFAULT_ZMR_WINDOW = 20;

const DEFAULT_PARAMS = Object.freeze({ smaFast: 50, smaSlow: 200, macd: DEFAULT_MACD_PERIODS, zmrWindow: DEFAULT_ZMR_WINDOW, zmrEntryZ: 2, zmrExitZ: 0.5 });
const DEFAULT_FOLDS = Object.freeze({ train: 504, validation: 126, holdout: 126, purge: 5 });
const DEFAULT_COST_MODEL_BPS = 5;
const DEFAULT_POLICY = Object.freeze({ metric: "annualizedSharpe", direction: "maximize", maximumHoldoutDrawdown: 1 });

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const sampleStdDev = (values) => {
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(1, values.length - 1));
};
const emaSeries = (values, period) => {
  const alpha = 2 / (period + 1);
  const output = [values[0]];
  for (let index = 1; index < values.length; index += 1) output.push(alpha * values[index] + (1 - alpha) * output[index - 1]);
  return output;
};

/**
 * Validates and columnarizes one ascending daily OHLCV bar series.
 * @param {{t: string, o: number, h: number, l: number, c: number, v: number}[]} bars
 * @returns {{dates: string[], opens: number[], highs: number[], lows: number[], closes: number[], volumes: number[]}}
 * @throws {TypeError} When bars is not an array of at least two strictly ascending, finite OHLCV observations.
 */
export function normalizeBars(bars) {
  if (!Array.isArray(bars) || bars.length < 2) throw new TypeError("bars must be an array of at least two observations");
  bars.forEach((bar, index) => {
    for (const field of ["t", "o", "h", "l", "c", "v"]) {
      if (bar?.[field] === undefined) throw new TypeError(`bars[${index}].${field} is required`);
    }
    for (const field of ["o", "h", "l", "c", "v"]) {
      if (!Number.isFinite(Number(bar[field]))) throw new TypeError(`bars[${index}].${field} must be finite`);
    }
    if (!Number.isFinite(Date.parse(bar.t))) throw new TypeError(`bars[${index}].t must be a valid date`);
    if (index > 0 && Date.parse(bar.t) <= Date.parse(bars[index - 1].t)) throw new TypeError(`bars must be strictly ascending by t (index ${index})`);
  });
  return Object.freeze({
    dates: bars.map((bar) => bar.t),
    opens: bars.map((bar) => Number(bar.o)),
    highs: bars.map((bar) => Number(bar.h)),
    lows: bars.map((bar) => Number(bar.l)),
    closes: bars.map((bar) => Number(bar.c)),
    volumes: bars.map((bar) => Number(bar.v)),
  });
}

/**
 * Always-long target-weight series.
 * @param {number} length
 * @returns {number[]} A constant series of 1.
 */
export function buyAndHoldWeights(length) {
  return Array.from({ length }, () => 1);
}

/**
 * Long when the fast simple moving average is above the slow one, flat otherwise.
 * @param {number[]} closes
 * @param {number} fastWindow
 * @param {number} slowWindow
 * @returns {number[]} A causal series in {0,1}.
 */
export function smaCrossWeights(closes, fastWindow, slowWindow) {
  const weights = new Array(closes.length).fill(0);
  for (let index = slowWindow - 1; index < closes.length; index += 1) {
    const fastAverage = mean(closes.slice(index - fastWindow + 1, index + 1));
    const slowAverage = mean(closes.slice(index - slowWindow + 1, index + 1));
    weights[index] = fastAverage > slowAverage ? 1 : 0;
  }
  return weights;
}

/**
 * Long when the MACD line is above its signal line, flat otherwise. Reuses
 * `measureTechnicalAnalysisFeatures` (fixed at MACD(12,26,9)) when the
 * requested periods match that default; computes the EMA difference
 * directly otherwise, since no published house primitive exposes a
 * parameterized MACD.
 * @param {{closes: number[], highs: number[], lows: number[], volumes: number[]}} bars
 * @param {[number, number, number]} macdPeriods `[fastPeriod, slowPeriod, signalPeriod]`.
 * @returns {number[]} A causal series in {0,1}.
 */
export function macdCrossWeights(bars, macdPeriods) {
  const [fastPeriod, slowPeriod, signalPeriod] = macdPeriods;
  const usesReusedWindow = fastPeriod === DEFAULT_MACD_PERIODS[0] && slowPeriod === DEFAULT_MACD_PERIODS[1] && signalPeriod === DEFAULT_MACD_PERIODS[2];
  if (usesReusedWindow) {
    return bars.closes.map((_, index) => {
      if (index < REUSED_FEATURE_FLOOR_INDEX) return 0;
      const measurement = measureTechnicalAnalysisFeatures({ closes: bars.closes, highs: bars.highs, lows: bars.lows, volumes: bars.volumes, index });
      return measurement.features.macdSignalSpreadFraction > 0 ? 1 : 0;
    });
  }
  const fast = emaSeries(bars.closes, fastPeriod);
  const slow = emaSeries(bars.closes, slowPeriod);
  const macdLine = fast.map((value, index) => value - slow[index]);
  const signalLine = emaSeries(macdLine, signalPeriod);
  const warm = Math.max(fastPeriod, slowPeriod) + signalPeriod;
  return bars.closes.map((_, index) => (index >= warm && macdLine[index] > signalLine[index] ? 1 : 0));
}

/**
 * Enters long when the close's rolling z-score falls to or below
 * `-entryZ`, exits when it rises to or above `-exitZ` (hysteresis band).
 * Reuses `measureTechnicalAnalysisFeatures`'s `bollingerZ20` when the
 * requested window is the default 20; computes the rolling z-score
 * directly otherwise, since that feature is fixed at a 20-period window.
 * @param {{closes: number[], highs: number[], lows: number[], volumes: number[]}} bars
 * @param {number} window
 * @param {number} entryZ
 * @param {number} exitZ
 * @returns {number[]} A causal, stateful series in {0,1}.
 */
export function zmrMeanReversionWeights(bars, window, entryZ, exitZ) {
  const usesReusedWindow = window === DEFAULT_ZMR_WINDOW;
  const weights = new Array(bars.closes.length).fill(0);
  let inPosition = false;
  for (let index = 0; index < bars.closes.length; index += 1) {
    let z = null;
    if (usesReusedWindow && index >= REUSED_FEATURE_FLOOR_INDEX) {
      z = measureTechnicalAnalysisFeatures({ closes: bars.closes, highs: bars.highs, lows: bars.lows, volumes: bars.volumes, index }).features.bollingerZ20;
    } else if (!usesReusedWindow && index >= window - 1) {
      const segment = bars.closes.slice(index - window + 1, index + 1);
      const average = mean(segment);
      const deviation = sampleStdDev(segment);
      z = deviation === 0 ? 0 : (bars.closes[index] - average) / deviation;
    }
    if (z !== null) {
      if (!inPosition && z <= -entryZ) inPosition = true;
      else if (inPosition && z >= -exitZ) inPosition = false;
    }
    weights[index] = inPosition ? 1 : 0;
  }
  return weights;
}

/**
 * Builds the four built-in baseline entries plus any external entries
 * from the request, each a `{id, authorActor, weights}` record index-aligned with `bars`.
 * @param {{closes: number[], highs: number[], lows: number[], volumes: number[]}} bars
 * @param {object} params Strategy parameters (see {@link DEFAULT_PARAMS}).
 * @param {{id: string, targetWeights: number[]}[]} [externalEntries]
 * @returns {{id: string, authorActor: string, weights: number[]}[]}
 * @throws {TypeError} When an external entry is malformed or not index-aligned with bars.
 */
export function buildEntries(bars, params, externalEntries) {
  const length = bars.closes.length;
  const builtins = [
    { id: "buy-and-hold", authorActor: "agent:strategy-tournament-service/buy-and-hold", weights: buyAndHoldWeights(length) },
    { id: "sma-cross", authorActor: "agent:strategy-tournament-service/sma-cross", weights: smaCrossWeights(bars.closes, params.smaFast, params.smaSlow) },
    { id: "macd", authorActor: "agent:strategy-tournament-service/macd", weights: macdCrossWeights(bars, params.macd) },
    { id: "zmr-mean-reversion", authorActor: "agent:strategy-tournament-service/zmr-mean-reversion", weights: zmrMeanReversionWeights(bars, params.zmrWindow, params.zmrEntryZ, params.zmrExitZ) },
  ];
  const externals = (externalEntries ?? []).map((entry) => {
    if (typeof entry?.id !== "string" || entry.id.length === 0) throw new TypeError("external entry id is required");
    if (!Array.isArray(entry.targetWeights) || entry.targetWeights.length !== length) throw new TypeError(`external entry ${entry.id} targetWeights must be index-aligned with bars`);
    return { id: entry.id, authorActor: `agent:strategy-tournament-service/external/${entry.id}`, weights: entry.targetWeights.map(Number) };
  });
  return [...builtins, ...externals];
}

const turnoverExcludingInitialEntry = (path) => path.slice(1).reduce((sum, period) => sum + period.turnover, 0);

/**
 * Normalizes IEEE-754 negative zero to positive zero. `-0` and `0` are the
 * same real number; the SEN JSON-to-term bridge this record's `id` crosses
 * refuses `-0` as non-injective under `JSON.stringify`, so a measure that
 * lands on exactly zero (a strategy that never traded in a segment, say)
 * must report `0`, never the bit-pattern artifact of negating it.
 * @param {number} value
 * @returns {number}
 */
function noNegativeZero(value) {
  return value === 0 ? 0 : value;
}

const sortinoRatio = (path, periodsPerYear) => {
  const netReturns = path.map((period) => period.netReturn);
  const downsideDeviation = Math.sqrt(mean(netReturns.map((value) => Math.min(0, value) ** 2)));
  if (downsideDeviation === 0) return 0;
  return (mean(netReturns) / downsideDeviation) * Math.sqrt(periodsPerYear);
};

/**
 * Derives the reported risk/performance measures from one
 * `replayTransactionCosts` result. `maxDrawdown` is signed negative
 * (financial convention); `turnover` excludes the segment's initial
 * position-funding trade, reporting only in-segment rebalancing.
 * @param {object} replay A `replayTransactionCosts` result.
 * @param {number} periodsPerYear Annualization base used for the replay.
 * @returns {{cagr: number, annualizedSharpe: number, sortino: number, maxDrawdown: number, turnover: number, hitRate: number}}
 */
export function deriveSegmentMeasures(replay, periodsPerYear) {
  return Object.freeze({
    cagr: noNegativeZero(replay.metrics.annualizedReturn),
    annualizedSharpe: noNegativeZero(replay.metrics.informationRatio),
    sortino: noNegativeZero(sortinoRatio(replay.path, periodsPerYear)),
    maxDrawdown: noNegativeZero(-replay.metrics.maximumDrawdown),
    turnover: noNegativeZero(turnoverExcludingInitialEntry(replay.path)),
    hitRate: noNegativeZero(replay.metrics.hitRate),
  });
}

function replayContinuousSegment({ dates, closes, weights, startIndex, endIndexExclusive, costModelBps, periodsPerYear }) {
  const periods = [];
  for (let index = Math.max(1, startIndex); index < endIndexExclusive; index += 1) {
    periods.push({ at: dates[index], weights: { [INSTRUMENT_KEY]: weights[index] }, realizedReturns: { [INSTRUMENT_KEY]: closes[index] / closes[index - 1] - 1 } });
  }
  return deriveSegmentMeasures(replayTransactionCosts({ periods, transactionCostBps: costModelBps, periodsPerYear }), periodsPerYear);
}

function replayFoldSegment({ dates, closes, weights, foldSet, costModelBps, periodsPerYear }) {
  const periods = foldSet.map((fold) => ({
    at: fold.outcomeAt,
    weights: { [INSTRUMENT_KEY]: weights[fold.prediction] },
    realizedReturns: { [INSTRUMENT_KEY]: closes[fold.outcome] / closes[fold.prediction] - 1 },
  }));
  return deriveSegmentMeasures(replayTransactionCosts({ periods, transactionCostBps: costModelBps, periodsPerYear }), periodsPerYear);
}

/**
 * Runs a deterministic strategy tournament: builds baseline and external
 * target-weight entries over one daily OHLCV series, replays each over a
 * continuous in-sample train segment and purged walk-forward
 * validation/holdout fold segments (`formPurgedWalkForwardFolds`,
 * `replayTransactionCosts`), selects on validation-only evidence
 * (`selectModelCandidate`), and reports untouched holdout for every
 * entry. The same input always produces the identical record `id`.
 * @param {object} request
 * @param {{t: string, o: number, h: number, l: number, c: number, v: number}[]} request.bars Ascending daily OHLCV observations.
 * @param {{id: string, targetWeights: number[]}[]} [request.entries] External target-weight entries, index-aligned with `bars`.
 * @param {number} [request.costModelBps] Linear transaction cost, in basis points; defaults to 5.
 * @param {{train: number, validation: number, holdout: number, purge: number}} [request.folds] Fold sizing in bars; defaults sized for multi-year daily history.
 * @param {{smaFast: number, smaSlow: number, macd: [number, number, number], zmrWindow: number, zmrEntryZ: number, zmrExitZ: number}} [request.params]
 * @param {{metric: string, direction: "maximize"|"minimize", maximumHoldoutDrawdown: number}} [request.policy] Validation-only selection policy; defaults to maximizing `annualizedSharpe`.
 * @returns {object} A frozen StrategyTournamentRecord.
 * @throws {TypeError} When bars, an external entry, or the requested folds are malformed or too short for the fold sizing.
 */
export function runStrategyTournament(request) {
  const bars = normalizeBars(request?.bars);
  const params = { ...DEFAULT_PARAMS, ...(request?.params ?? {}) };
  const folds = { ...DEFAULT_FOLDS, ...(request?.folds ?? {}) };
  const costModelBps = Number.isFinite(request?.costModelBps) ? request.costModelBps : DEFAULT_COST_MODEL_BPS;
  const policy = { ...DEFAULT_POLICY, ...(request?.policy ?? {}) };

  if (!(folds.train >= 3)) throw new TypeError("folds.train must be at least 3");
  if (bars.closes.length <= folds.train + folds.purge + 2) throw new TypeError("bars is too short for the requested folds");

  const entries = buildEntries(bars, params, request?.entries);

  const foldsResult = formPurgedWalkForwardFolds({
    coordinates: bars.dates,
    warmup: folds.train,
    horizon: folds.purge,
    trainingWindow: folds.train,
    validationFraction: folds.validation / (folds.validation + folds.holdout),
  });
  const foldPeriodsPerYear = 252 / folds.purge;

  const entryMeasures = entries.map((entry) => ({
    id: entry.id,
    authorActor: entry.authorActor,
    train: replayContinuousSegment({ dates: bars.dates, closes: bars.closes, weights: entry.weights, startIndex: 1, endIndexExclusive: folds.train, costModelBps, periodsPerYear: 252 }),
    validation: replayFoldSegment({ dates: bars.dates, closes: bars.closes, weights: entry.weights, foldSet: foldsResult.validation, costModelBps, periodsPerYear: foldPeriodsPerYear }),
    holdout: replayFoldSegment({ dates: bars.dates, closes: bars.closes, weights: entry.weights, foldSet: foldsResult.holdout, costModelBps, periodsPerYear: foldPeriodsPerYear }),
  }));

  const candidates = entryMeasures.map((measure) => ({
    id: measure.id,
    authorActor: measure.authorActor,
    validation: { ...measure.validation, maximumDrawdown: Math.abs(measure.validation.maxDrawdown) },
    holdout: { ...measure.holdout, maximumDrawdown: Math.abs(measure.holdout.maxDrawdown) },
  }));
  const selected = selectModelCandidate({ candidates, policy });
  const holdout = Object.fromEntries(entryMeasures.map((measure) => [measure.id, measure.holdout]));

  const body = {
    type: "StrategyTournamentRecord",
    version: 1,
    inputsDigest: identifyJsonSemanticContent({ objectKind: "alpaca.strategy-tournament.input", value: request, witnessRoot: EMPTY_WITNESS_ROOT }).id,
    params,
    folds,
    entries: entryMeasures,
    selected,
    holdout,
  };
  const id = identifyJsonSemanticContent({ objectKind: "alpaca.strategy-tournament.record", value: body, witnessRoot: EMPTY_WITNESS_ROOT }).id;
  return Object.freeze({ id, ...body });
}
