import { config } from './config.js';
import { retrieveRelevantChunks } from './vectorStore.js';

export interface ReviewComment {
  filePath: string;
  line: number | null;
  severity: 'blocking' | 'suggestion' | 'nitpick';
  comment: string;
}

export interface FileDiff {
  filePath: string;
  patch: string; // unified diff for this file
}

const SYSTEM_PROMPT = `You are a senior code reviewer for this specific repository.
You have been given retrieved snippets of the repo's EXISTING code to learn its
conventions (naming, error handling style, testing patterns, structure) — use
those as ground truth, not generic best practices.

Rules:
- Always flag hardcoded secrets, API keys, passwords, or tokens committed
  directly in source code — this is ALWAYS "blocking" severity, no exceptions.
- Always flag places where a value that could be null or undefined (e.g. the
  result of a lookup, find, or optional field) is accessed without a guard,
  optional chaining, or a check first — this is "blocking" severity, since
  it will throw at runtime.
- Only comment on things that matter: bugs, inconsistency with the repo's own
  conventions, missing error handling, unclear naming. Do not nitpick style
  that a formatter would catch.
- Every comment must reference the specific line or lines it applies to.
- Classify each comment's severity as "blocking" (bug/breaks something),
  "suggestion" (real improvement, not required), or "nitpick" (minor, optional).
- If the diff is genuinely fine, return an empty comments array. Do not
  invent issues to seem thorough. A short, type-correct, self-explanatory
  function does NOT need suggestions about hypothetical edge cases (NaN,
  empty input), added documentation/comments, or other "nice to have"
  polish — only comment on those if the diff's own context makes them
  genuinely necessary, not just generally good practice.
- Respond with ONLY valid JSON matching this shape, no prose, no markdown fences:
  { "comments": [ { "filePath": string, "line": number | null, "severity": string, "comment": string } ] }

Examples of correct output:

Diff shows: "const user = findUser(id); return user.email;"
Correct output: { "comments": [ { "filePath": "src/user.ts", "line": 2, "severity": "blocking", "comment": "findUser may return undefined if no user matches. Accessing .email without a guard will throw. Add a check: if (!user) throw/return early." } ] }

Diff shows: "const apiKey = 'sk-live-abc123';"
Correct output: { "comments": [ { "filePath": "src/client.ts", "line": 1, "severity": "blocking", "comment": "Hardcoded API key committed to source. Move this to an environment variable instead." } ] }

Diff shows: "await fetchData(); await saveToDb(data);" with no surrounding try/catch
Correct output: { "comments": [ { "filePath": "src/sync.ts", "line": 2, "severity": "suggestion", "comment": "These awaited calls have no error handling. If either rejects, the caller gets an unhandled rejection. Consider wrapping in try/catch." } ] }

Diff shows: "export function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }"
Correct output: { "comments": [] }
(This is correct and complete as written — do not suggest docs, edge-case handling, or exports it doesn't need.)`;

async function callGroq(userMessage: string): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.groqApiKey}`,
    },
    body: JSON.stringify({
      model: config.groqModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Groq request failed: ${res.status} ${await res.text()}. ` +
        `Check that GROQ_API_KEY is set and the "${config.groqModel}" model name is valid.`
    );
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices[0].message.content;
}
export async function reviewDiff(diff: FileDiff): Promise<ReviewComment[]> {
  console.log(`[reviewDiff] Retrieving context for ${diff.filePath}...`);
  const context = await retrieveRelevantChunks(diff.patch, 5);
  console.log(`[reviewDiff] Retrieved ${context.length} chunks. Calling Groq...`);

  const contextBlock = context
    .map((c) => `--- ${c.filePath} ---\n${c.content}`)
    .join('\n\n');

  const userMessage = `Repo context (existing code, for convention reference):
${contextBlock || '(no relevant context found — repo may not be indexed yet)'}

---

File being reviewed: ${diff.filePath}

Diff:
${diff.patch}`;

  const responseText = await callGroq(userMessage);
  console.log(`[reviewDiff] Groq responded for ${diff.filePath}.`);

  try {
    const parsed = JSON.parse(responseText) as { comments: ReviewComment[] };
    return parsed.comments;
  } catch (err) {
    throw new Error(
      `Failed to parse model response as JSON. Raw response: ${responseText}`
    );
  }
}

export async function reviewPullRequest(diffs: FileDiff[]): Promise<ReviewComment[]> {
  const results = await Promise.all(diffs.map(reviewDiff));
  return results.flat();
}