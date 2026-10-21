import type { FileDiff } from '../agent-core/reviewer.js';

/**
 * Each test case is a diff with a KNOWN issue planted in it, plus what a
 * correct review should flag. This is the "labeled test set" that lets us
 * score the agent objectively instead of eyeballing its output.
 *
 * Grow this file as you find real review
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
    description: 'Property access on a possibly-undefined lookup result',
    diff: {
      filePath: 'src/user.ts',
      patch: `@@ -10,6 +10,9 @@
 function getUserEmail(userId: string) {
   const user = findUser(userId);
+  return user.email;
 }`,
    },
    expectedIssues: [{ mustMentionKeywords: ['undefined', 'null', 'guard'], minSeverity: 'blocking' }],
  },
  {
    id: 'null-check-array-find',
    description: 'Array.find result used without a guard',
    diff: {
      filePath: 'src/cart.ts',
      patch: `@@ -4,4 +4,6 @@
 function itemPrice(items: Item[], sku: string) {
+  const item = items.find((i) => i.sku === sku);
+  return item.price * item.qty;
 }`,
    },
    expectedIssues: [{ mustMentionKeywords: ['undefined', 'null', 'guard'], minSeverity: 'blocking' }],
  },
  {
    id: 'unhandled-promise-rejection',
    description: 'Awaited calls with no try/catch',
    diff: {
      filePath: 'src/sync.ts',
      patch: `@@ -1,4 +1,6 @@
 async function syncData() {
+  const data = await fetchExternalData();
+  await saveToDatabase(data);
 }`,
    },
    expectedIssues: [{ mustMentionKeywords: ['catch', 'error handling', 'reject'], minSeverity: 'suggestion' }],
  },
  {
    id: 'floating-promise',
    description: 'Async call fired without await or catch',
    diff: {
      filePath: 'src/jobs.ts',
      patch: `@@ -3,4 +3,5 @@
 export function onSignup(user: User) {
+  sendWelcomeEmail(user.email);
   return user.id;
 }`,
    },
    expectedIssues: [{ mustMentionKeywords: ['await', 'catch', 'promise', 'reject'], minSeverity: 'suggestion' }],
  },
  {
    id: 'hardcoded-api-key',
    description: 'API key committed in source',
    diff: {
      filePath: 'src/client.ts',
      patch: `@@ -1,3 +1,5 @@
+const apiKey = "sk-live-abc123def456";
+const client = new ApiClient(apiKey);`,
    },
    expectedIssues: [{ mustMentionKeywords: ['hardcod', 'environment', 'secret'], minSeverity: 'blocking' }],
  },
  {
    id: 'hardcoded-db-password',
    description: 'Database password committed in source',
    diff: {
      filePath: 'src/db.ts',
      patch: `@@ -1,3 +1,7 @@
+export const pool = new Pool({
+  host: 'db.internal',
+  user: 'admin',
+  password: 'Sup3rS3cret!',
+});`,
    },
    expectedIssues: [{ mustMentionKeywords: ['hardcod', 'password', 'environment', 'secret'], minSeverity: 'blocking' }],
  },
  {
    id: 'hardcoded-token-header',
    description: 'Bearer token committed in source',
    diff: {
      filePath: 'src/api.ts',
      patch: `@@ -2,3 +2,6 @@
+const headers = {
+  Authorization: 'Bearer ghp_1234567890abcdefghijklmnopqrstuvwxyz',
+};`,
    },
    expectedIssues: [{ mustMentionKeywords: ['hardcod', 'token', 'environment', 'secret'], minSeverity: 'blocking' }],
  },
  {
    id: 'sql-injection',
    description: 'SQL built by string concatenation with user input',
    diff: {
      filePath: 'src/users.ts',
      patch: `@@ -5,3 +5,5 @@
 export async function getUser(db: Db, name: string) {
+  return db.query("SELECT * FROM users WHERE name = '" + name + "'");
 }`,
    },
    expectedIssues: [{ mustMentionKeywords: ['injection', 'parameter', 'sanitiz', 'prepared'], minSeverity: 'blocking' }],
  },
  {
    id: 'xss-inner-html',
    description: 'User-provided string written to innerHTML',
    diff: {
      filePath: 'src/render.ts',
      patch: `@@ -2,3 +2,5 @@
 export function showComment(el: HTMLElement, comment: string) {
+  el.innerHTML = comment;
 }`,
    },
    expectedIssues: [{ mustMentionKeywords: ['xss', 'sanitiz', 'innerhtml', 'textcontent', 'escape'], minSeverity: 'blocking' }],
  },
  {
    id: 'missing-await',
    description: 'Async result used as if it were resolved',
    diff: {
      filePath: 'src/orders.ts',
      patch: `@@ -7,3 +7,5 @@
 async function total(orderId: string) {
+  const order = fetchOrder(orderId);
+  return order.items.length;
 }`,
    },
    expectedIssues: [{ mustMentionKeywords: ['await', 'promise'], minSeverity: 'blocking' }],
  },
  {
    id: 'off-by-one-loop',
    description: 'Loop bound reads past the end of the array',
    diff: {
      filePath: 'src/sum.ts',
      patch: `@@ -1,3 +1,7 @@
+export function sum(nums: number[]) {
+  let total = 0;
+  for (let i = 0; i <= nums.length; i++) total += nums[i];
+  return total;
+}`,
    },
    expectedIssues: [{ mustMentionKeywords: ['off-by-one', '<=', 'out of bounds', 'nan', 'undefined', 'length'], minSeverity: 'blocking' }],
  },
  {
    id: 'empty-catch',
    description: 'Error swallowed by an empty catch block',
    diff: {
      filePath: 'src/save.ts',
      patch: `@@ -4,5 +4,9 @@
 async function save(doc: Doc) {
+  try {
+    await writeDoc(doc);
+  } catch (e) {}
 }`,
    },
    expectedIssues: [{ mustMentionKeywords: ['swallow', 'empty', 'catch', 'ignore', 'log'], minSeverity: 'suggestion' }],
  },
  {
    id: 'react-state-mutation',
    description: 'React state mutated directly instead of via setState',
    diff: {
      filePath: 'src/List.jsx',
      patch: `@@ -8,4 +8,6 @@
   const [items, setItems] = useState([]);
+  function add(item) {
+    items.push(item);
+    setItems(items);
+  }`,
    },
    expectedIssues: [{ mustMentionKeywords: ['mutat', 'immutab', 'new array', 'spread', 'copy'], minSeverity: 'blocking' }],
  },
  {
    id: 'effect-missing-cleanup',
    description: 'setInterval in useEffect never cleared',
    diff: {
      filePath: 'src/Clock.jsx',
      patch: `@@ -5,4 +5,7 @@
 function Clock() {
+  useEffect(() => {
+    setInterval(() => setNow(Date.now()), 1000);
+  }, []);
 }`,
    },
    expectedIssues: [{ mustMentionKeywords: ['cleanup', 'clearinterval', 'leak', 'unmount'], minSeverity: 'blocking' }],
  },
  {
    id: 'secret-logged',
    description: 'Auth token written to logs',
    diff: {
      filePath: 'src/auth.ts',
      patch: `@@ -9,3 +9,4 @@
 export function login(token: string) {
+  console.log('logging in with token', token);
 }`,
    },
    expectedIssues: [{ mustMentionKeywords: ['log', 'secret', 'token', 'leak', 'sensitive'], minSeverity: 'blocking' }],
  },
  {
    id: 'clean-clamp',
    description: 'Pure typed helper',
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
    id: 'clean-guarded-lookup',
    description: 'Lookup with an explicit guard',
    diff: {
      filePath: 'src/user.ts',
      patch: `@@ -10,6 +10,10 @@
 function getUserEmail(userId: string) {
   const user = findUser(userId);
+  if (!user) {
+    throw new Error('User not found: ' + userId);
+  }
+  return user.email;
 }`,
    },
    expectedIssues: [],
    expectNoIssues: true,
  },
  {
    id: 'clean-async-with-handling',
    description: 'Async work wrapped in try/catch with context',
    diff: {
      filePath: 'src/sync.ts',
      patch: `@@ -1,4 +1,11 @@
 async function syncData() {
+  try {
+    const data = await fetchExternalData();
+    await saveToDatabase(data);
+  } catch (err) {
+    console.error('syncData failed:', err);
+    throw err;
+  }
 }`,
    },
    expectedIssues: [],
    expectNoIssues: true,
  },
  {
    id: 'clean-env-config',
    description: 'Secret read from environment',
    diff: {
      filePath: 'src/client.ts',
      patch: `@@ -1,3 +1,6 @@
+const apiKey = process.env.API_KEY;
+if (!apiKey) throw new Error('API_KEY is not set');
+const client = new ApiClient(apiKey);`,
    },
    expectedIssues: [],
    expectNoIssues: true,
  },
  {
    id: 'clean-parameterized-query',
    description: 'Parameterized SQL',
    diff: {
      filePath: 'src/users.ts',
      patch: `@@ -5,3 +5,5 @@
 export async function getUser(db: Db, name: string) {
+  return db.query('SELECT * FROM users WHERE name = $1', [name]);
 }`,
    },
    expectedIssues: [],
    expectNoIssues: true,
  },
  {
    id: 'clean-effect-with-cleanup',
    description: 'useEffect that clears its interval',
    diff: {
      filePath: 'src/Clock.jsx',
      patch: `@@ -5,4 +5,8 @@
 function Clock() {
+  useEffect(() => {
+    const id = setInterval(() => setNow(Date.now()), 1000);
+    return () => clearInterval(id);
+  }, []);
 }`,
    },
    expectedIssues: [],
    expectNoIssues: true,
  },
  {
    id: 'clean-immutable-state',
    description: 'State updated immutably',
    diff: {
      filePath: 'src/List.jsx',
      patch: `@@ -8,4 +8,5 @@
   const [items, setItems] = useState([]);
+  const add = (item) => setItems((prev) => [...prev, item]);`,
    },
    expectedIssues: [],
    expectNoIssues: true,
  },
  {
    id: 'clean-array-transform',
    description: 'Simple filter/map pipeline',
    diff: {
      filePath: 'src/list.ts',
      patch: `@@ -1,3 +1,6 @@
+export const activeNames = (users: User[]): string[] =>
+  users.filter((u) => u.active).map((u) => u.name);`,
    },
    expectedIssues: [],
    expectNoIssues: true,
  },
  {
    id: 'clean-constant',
    description: 'Exported constant',
    diff: {
      filePath: 'src/constants.ts',
      patch: `@@ -1,2 +1,3 @@
+export const MAX_RETRIES = 3;`,
    },
    expectedIssues: [],
    expectNoIssues: true,
  },
];
