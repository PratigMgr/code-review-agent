import { evalCases } from './test-cases.js';
import { gradeCase, summarize, type CaseResult } from './grader.js';
import { reviewDiff } from '../agent-core/reviewer.js';

async function main() {
  console.log(`Running ${evalCases.length} eval cases against the review agent...\n`);

  const results: CaseResult[] = [];

  for (const evalCase of evalCases) {
    process.stdout.write(`Running: ${evalCase.id}... `);
    try {
      const comments = await reviewDiff(evalCase.diff);
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

  const failed = results.filter((r) => !r.passed).length;
  if (failed > 0) {
    console.log(`\n${failed} case(s) failed. Fix the agent or update the test case, then re-run.`);
    process.exit(1);
  } else {
    console.log('\nAll eval cases passed.');
  }
}

main();
