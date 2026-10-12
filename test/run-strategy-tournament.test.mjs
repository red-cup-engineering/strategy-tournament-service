import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runStrategyTournament } from "../src/strategy-tournament.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Loads the recorded real BTC/USD daily coingecko series and shapes it as
 * ascending daily OHLCV bars. The fixture carries one recorded price per
 * day (no OHLC bucketing), so open/high/low/close are all set to that
 * real recorded price -- a degenerate real-price bar, never a synthesized one.
 * @returns {{t: string, o: number, h: number, l: number, c: number, v: number}[]}
 */
function loadFixtureBars() {
  const fixture = JSON.parse(readFileSync(join(HERE, "fixtures", "btc-365d-coingecko.json"), "utf8"));
  return fixture.series.map((row) => ({ t: row.date, o: row.price, h: row.price, l: row.price, c: row.price, v: row.volume }));
}

const FOLDS = { train: 220, validation: 60, holdout: 75, purge: 5 };
const BUILTIN_IDS = ["buy-and-hold", "sma-cross", "macd", "zmr-mean-reversion"];

test("same input produces the identical record id across repeated runs", () => {
  const bars = loadFixtureBars();
  const first = runStrategyTournament({ bars, folds: FOLDS });
  const second = runStrategyTournament({ bars, folds: FOLDS });
  assert.equal(first.id, second.id);
  assert.equal(typeof first.id, "string");
  assert.ok(first.id.length > 0);
});

test("buy-and-hold on the fixture holdout has a negative maxDrawdown and zero turnover", () => {
  const bars = loadFixtureBars();
  const record = runStrategyTournament({ bars, folds: FOLDS });
  const buyAndHold = record.entries.find((entry) => entry.id === "buy-and-hold");
  assert.ok(buyAndHold, "buy-and-hold entry is present");
  assert.ok(buyAndHold.holdout.maxDrawdown < 0, `expected a negative holdout drawdown, got ${buyAndHold.holdout.maxDrawdown}`);
  assert.equal(buyAndHold.holdout.turnover, 0);
  assert.equal(record.holdout["buy-and-hold"].maxDrawdown, buyAndHold.holdout.maxDrawdown);
});

test("all four built-in baselines report train/validation/holdout measures", () => {
  const bars = loadFixtureBars();
  const record = runStrategyTournament({ bars, folds: FOLDS });
  assert.equal(record.type, "StrategyTournamentRecord");
  assert.equal(record.version, 1);
  const reportedIds = record.entries.map((entry) => entry.id).sort();
  assert.deepEqual(reportedIds, [...BUILTIN_IDS].sort());
  for (const entry of record.entries) {
    for (const segment of ["train", "validation", "holdout"]) {
      for (const measure of ["cagr", "annualizedSharpe", "sortino", "maxDrawdown", "turnover", "hitRate"]) {
        assert.equal(typeof entry[segment][measure], "number", `${entry.id}.${segment}.${measure} is a number`);
        assert.ok(Number.isFinite(entry[segment][measure]), `${entry.id}.${segment}.${measure} is finite`);
      }
    }
  }
});

test("an external entry is scored alongside the built-in baselines and selectable", () => {
  const bars = loadFixtureBars();
  const alwaysFlat = bars.map(() => 0);
  const record = runStrategyTournament({ bars, folds: FOLDS, entries: [{ id: "external-flat", targetWeights: alwaysFlat }] });
  const reportedIds = record.entries.map((entry) => entry.id).sort();
  assert.deepEqual(reportedIds, [...BUILTIN_IDS, "external-flat"].sort());
  const external = record.entries.find((entry) => entry.id === "external-flat");
  assert.equal(external.holdout.turnover, 0);
  assert.equal(external.holdout.cagr, 0);
  assert.ok(record.holdout["external-flat"]);
  assert.ok(BUILTIN_IDS.includes(record.selected.selectedUsingValidationOnly) || record.selected.selectedUsingValidationOnly === "external-flat");
  assert.equal(record.selected.validationRanking.length, BUILTIN_IDS.length + 1);
});

test("selection reads validation only: holdout is reported for every entry regardless of who was selected", () => {
  const bars = loadFixtureBars();
  const record = runStrategyTournament({ bars, folds: FOLDS });
  assert.deepEqual(Object.keys(record.selected.untouchedHoldout).sort(), [...BUILTIN_IDS].sort());
  assert.deepEqual(Object.keys(record.holdout).sort(), [...BUILTIN_IDS].sort());
});

test("refuses bars shorter than two observations", () => {
  assert.throws(() => runStrategyTournament({ bars: [{ t: "2026-01-01", o: 1, h: 1, l: 1, c: 1, v: 1 }] }), /at least two observations/u);
});

test("refuses a request without bars", () => {
  assert.throws(() => runStrategyTournament({}), TypeError);
});

test("refuses an external entry whose targetWeights is not index-aligned with bars", () => {
  const bars = loadFixtureBars();
  assert.throws(() => runStrategyTournament({ bars, folds: FOLDS, entries: [{ id: "short", targetWeights: [0, 1] }] }), /targetWeights must be index-aligned/u);
});
