import fs from 'node:fs/promises';
import path from 'node:path';
import { evalCases } from './test-cases.js';
import { gradeCase, summarize, type CaseResult } from './grader.js';
import { reviewDiff } from '../agent-core/reviewer.js';
import { config } from '../agent-core/config.js';

export const EVAL_RESULTS_PATH = path.resolve('data/eval-results.json');

export interface EvalRun {
  timestamp: string;
  model: string;
  retrieval: boolean;
  passed: number;
  total: number;
  cases: CaseResult[];
}

async function runOnce(retrieval: boolean): Promise<EvalRun> {
  console.log(
    `\nRunning ${evalCases.length} eval cases (retrieval ${retrieval ? 'ON' : 'OFF'})...\n`
  );
  const results: CaseResult[] = [];

  for (const evalCase of evalCases) {
    process.stdout.write(`Running: ${evalCase.id}... `);
    try {
      const comments = await reviewDiff(evalCase.diff, { useRetrieval: retrieval });
      const result = gradeCase(evalCase, comments);
      results.push(result);
      console.log(result.passed ? 'pass' : 'FAIL');
    } catch (err) {
      results.push({
        caseId: evalCase.id,
        passed: false,
        notes: [`Threw an error: ${err instanceof Error ? err.message : String(err)}`],
      });
      console.log('ERROR');
    }
  }

  console.log(summarize(results));
  return {
    timestamp: new Date().toISOString(),
    model: config.groqModel,
    retrieval,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    cases: results,
  };
}

async function saveRuns(runs: EvalRun[]): Promise<void> {
  let history: EvalRun[] = [];
  try {
    history = JSON.parse(await fs.readFile(EVAL_RESULTS_PATH, 'utf-8'));
  } catch {
    // first run, or unreadable file: start a fresh history
  }
  history.push(...runs);
  await fs.mkdir(path.dirname(EVAL_RESULTS_PATH), { recursive: true });
  await fs.writeFile(EVAL_RESULTS_PATH, JSON.stringify(history, null, 2), 'utf-8');
  console.log(`\nSaved ${runs.length} run(s) to ${EVAL_RESULTS_PATH} (view them at /dashboard).`);
}

// Usage: npm run eval            -> retrieval on
//        npm run eval -- --no-retrieval
//        npm run eval -- --both  -> runs both, so the dashboard can compare them
async function main() {
  const args = process.argv.slice(2);
  const modes = args.includes('--both') ? [true, false] : [!args.includes('--no-retrieval')];

  const runs: EvalRun[] = [];
  for (const retrieval of modes) runs.push(await runOnce(retrieval));
  // Don't pollute the dashboard history with runs that errored out (rate limits etc.)
  const errored = runs.some((r) => r.cases.some((c) => c.notes.some((n) => n.startsWith('Threw an error'))));
  if (errored) {
    console.log('\nSome cases threw errors (not real failures); NOT saving this run to the dashboard.');
  } else {
    await saveRuns(runs);
  }

  const failed = runs.reduce((n, r) => n + (r.total - r.passed), 0);
  if (failed > 0) {
    console.log(`\n${failed} case(s) failed. Fix the agent or update the test case, then re-run.`);
    process.exit(1);
  } else {
    console.log('\nAll eval cases passed.');
  }
}

main();
