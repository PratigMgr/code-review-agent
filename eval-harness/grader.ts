import type { ReviewComment } from '../agent-core/reviewer.js';
import type { EvalCase } from './test-cases.js';

const SEVERITY_RANK = { nitpick: 0, suggestion: 1, blocking: 2 } as const;

export interface CaseResult {
  caseId: string;
  passed: boolean;
  notes: string[];
}

export function gradeCase(evalCase: EvalCase, actualComments: ReviewComment[]): CaseResult {
  const notes: string[] = [];

  if (evalCase.expectNoIssues) {
    const passed = actualComments.length === 0;
    if (!passed) {
      notes.push(
        `Expected no issues, but agent raised ${actualComments.length}: ` +
          actualComments.map((c) => `"${c.comment}"`).join('; ')
      );
    }
    return { caseId: evalCase.id, passed, notes };
  }

  let allExpectedFound = true;

  for (const expected of evalCase.expectedIssues) {
    const matched = actualComments.find((c) => {
      const commentLower = c.comment.toLowerCase();
      const keywordHit = expected.mustMentionKeywords.some((kw) =>
        commentLower.includes(kw.toLowerCase())
      );
      const severityOk = SEVERITY_RANK[c.severity] >= SEVERITY_RANK[expected.minSeverity];
      return keywordHit && severityOk;
    });

    if (!matched) {
      allExpectedFound = false;
      notes.push(
        `Missed expected issue (keywords: ${expected.mustMentionKeywords.join('/')}, ` +
          `min severity: ${expected.minSeverity})`
      );
    }
  }

  return { caseId: evalCase.id, passed: allExpectedFound, notes };
}

export function summarize(results: CaseResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const lines = [`\nEval results: ${passed}/${total} passed\n`];

  for (const r of results) {
    lines.push(`${r.passed ? '✅' : '❌'} ${r.caseId}`);
    for (const note of r.notes) lines.push(`   ${note}`);
  }

  return lines.join('\n');
}
