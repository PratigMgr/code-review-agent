import type { FileDiff } from '../agent-core/reviewer.js';

/**
 * Each test case is a diff with a KNOWN issue planted in it, plus what a
 * correct review should flag. This is the "labeled test set" that lets us
 * score the agent objectively instead of eyeballing its output.
 *
 * Start small (5-10 cases) and grow this file as you find real review
 * misses in production — every missed bug becomes a new regression test.
 */
export interface EvalCase {
  id: string;
  description: string;
  diff: FileDiff;
  expectedIssues: {
    // What we expect the agent to catch. Kept loose (keyword-based) because
    // grading exact LLM phrasing is brittle — see grader.ts for how this is used.
    mustMentionKeywords: string[];
    minSeverity: 'nitpick' | 'suggestion' | 'blocking';
  }[];
  // Cases where the agent should NOT flag anything (fine code) — these catch
  // over-eager agents that invent issues to seem thorough.
  expectNoIssues?: boolean;
}

export const evalCases: EvalCase[] = [
  {
    id: 'missing-null-check',
    description: 'Diff accesses a property on a possibly-undefined value without a guard',
    diff: {
      filePath: 'src/user.ts',
      patch: `@@ -10,6 +10,9 @@
 function getUserEmail(userId: string) {
   const user = findUser(userId);
+  return user.email;
 }`,
    },
    expectedIssues: [
      {
        mustMentionKeywords: ['undefined', 'null', 'guard', 'check'],
        minSeverity: 'blocking',
      },
    ],
  },
  {
    id: 'unhandled-promise-rejection',
    description: 'Async call with no try/catch or .catch()',
    diff: {
      filePath: 'src/sync.ts',
      patch: `@@ -1,4 +1,6 @@
 async function syncData() {
+  const data = await fetchExternalData();
+  await saveToDatabase(data);
 }`,
    },
    expectedIssues: [
      {
        mustMentionKeywords: ['error', 'catch', 'handling', 'reject'],
        minSeverity: 'suggestion',
      },
    ],
  },
  {
    id: 'hardcoded-secret',
    description: 'API key committed directly in source',
    diff: {
      filePath: 'src/client.ts',
      patch: `@@ -1,3 +1,5 @@
+const apiKey = "sk-live-abc123def456";
+const client = new ApiClient(apiKey);`,
    },
    expectedIssues: [
      {
        mustMentionKeywords: ['secret', 'key', 'hardcod', 'environment', 'env'],
        minSeverity: 'blocking',
      },
    ],
  },
  {
    id: 'clean-code-no-issues',
    description: 'A well-written, unremarkable diff — agent should NOT invent issues',
    diff: {
      filePath: 'src/math.ts',
      patch: `@@ -1,3 +1,6 @@
+export function clamp(value: number, min: number, max: number): number {
+  return Math.min(Math.max(value, min), max);
+}`,
    },
    expectedIssues: [],
    expectNoIssues: true,
  },
  {
    id: 'inconsistent-naming',
    description: 'New function uses camelCase where repo convention (from indexed context) is snake_case, or vice versa — depends on target repo',
    diff: {
      filePath: 'src/handlers.ts',
      patch: `@@ -5,4 +5,7 @@
+function Handle_Request(req: Request) {
+  return processRequest(req);
+}`,
    },
    expectedIssues: [
      {
        mustMentionKeywords: ['naming', 'convention', 'consistent', 'case'],
        minSeverity: 'nitpick',
      },
    ],
  },
];
