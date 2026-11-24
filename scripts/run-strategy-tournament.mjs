#!/usr/bin/env node
import { runStrategyTournament } from "../src/strategy-tournament.mjs";
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Runs the strategy tournament CLI face: reads one JSON request object
 * from stdin, writes the frozen StrategyTournamentRecord to stdout, and
 * exits 2 with a `{error}` refusal datum on stderr when the request is
 * malformed or too short for its requested folds.
 * @returns {Promise<void>}
 */
export async function main() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  let request;
  try {
    request = JSON.parse(text);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: `invalid-json: ${error.message}` })}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const record = runStrategyTournament(request);
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 2;
  }
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "run-strategy-tournament", description: "Runs the strategy tournament CLI face: reads one JSON request object from stdin, writes the frozen StrategyTournamentRecord to stdout, and exits 2 with a `{error}` refusal datum on stderr when the request is malformed or too short for its requested folds.", operation: main }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
