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

export const SYSTEM_PROMPT = `You are a senior code reviewer for this specific repository.
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
- Always flag user-controlled strings assigned to innerHTML / outerHTML /
  dangerouslySetInnerHTML / document.write — this is an XSS risk and is
  "blocking". Suggest textContent or sanitizing the input.
- Always flag an async function call whose promise is neither awaited, returned,
  nor given a .catch() (a "floating promise") — if it rejects, the error is
  unhandled. Use "suggestion" severity at minimum.
- Always flag a useEffect that starts a setInterval, setTimeout, subscription,
  or event listener without returning a cleanup function that clears it — it
  leaks after unmount. This is "blocking".
- Always flag logging (console.log, logger.*) of secrets, tokens, passwords, or
  other credentials — this is "blocking" since it leaks them into log storage.
- Always flag SQL built by string concatenation or template interpolation with
  variables or user input (e.g. "... WHERE name = '" + name + "'"). This is SQL
  injection and is "blocking"; recommend parameterized queries / prepared
  statements. (This does NOT apply to queries that already use placeholders
  such as $1 or ? with a separate parameters array.)
- Always flag awaited I/O calls (network requests, database, filesystem) that
  have no try/catch or .catch() visible in the diff — a rejection becomes an
  unhandled error. Use "suggestion" severity. (This does NOT apply if the diff
  already shows try/catch around them.)
- You are shown only a diff hunk, not the whole file. NEVER flag missing
  imports, undeclared types, or identifiers that are probably defined or
  imported elsewhere in the file (e.g. useEffect, useState, a User type).
  Only judge the lines that actually changed.
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

const MAX_RETRIES = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long Groq wants us to wait after a 429, in ms (header first, then message text). */
function retryDelayMs(res: Response, body: string, attempt: number): number {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000 + 1000;
  const m = body.match(/try again in ([\d.]+)(ms|s)/i);
  if (m) return Math.ceil(Number(m[1]) * (m[2].toLowerCase() === 'ms' ? 1 : 1000)) + 1000;
  return Math.min(2 ** attempt * 1000, 30_000); // fallback: exponential backoff
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Shared Groq call with rate-limit retry. Used by the reviewer and the dashboard assistant. */
export async function groqChat(
  messages: ChatMessage[],
  opts: { json?: boolean; model?: string } = {}
): Promise<string> {
  const model = opts.model || config.groqModel;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.groqApiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: opts.json ? 0 : 0.3,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        messages,
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as {
        choices: { message: { content: string } }[];
      };
      return data.choices[0].message.content;
    }

    const body = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      const wait = retryDelayMs(res, body, attempt);
      console.log(
        `[groqChat] ${res.status}, waiting ${(wait / 1000).toFixed(1)}s ` +
          `(retry ${attempt + 1}/${MAX_RETRIES})...`
      );
      await sleep(wait);
      continue;
    }

    throw new Error(
      `Groq request failed: ${res.status} ${body}. ` +
        `Check that GROQ_API_KEY is set and the "${model}" model name is valid.`
    );
  }
}

async function callGroq(userMessage: string): Promise<string> {
  return groqChat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    { json: true }
  );
}

export interface ReviewOptions {
  /** Set to false to skip repo-context retrieval (used by evals to measure its effect). */
  useRetrieval?: boolean;
}

export async function reviewDiff(
  diff: FileDiff,
  options: ReviewOptions = {}
): Promise<ReviewComment[]> {
  const { useRetrieval = true } = options;
  console.log(`[reviewDiff] Retrieving context for ${diff.filePath}...`);
  const context = useRetrieval ? await retrieveRelevantChunks(diff.patch, 5) : [];
  console.log(`[reviewDiff] Retrieved ${context.length} chunks. Calling Groq...`);

  const contextBlock = context
    .map((c) => `--- ${c.filePath} ---\n${c.content}`)
    .join('\n\n');

  const userMessage = `Repo context (existing code, for convention reference):
${contextBlock || '(no repo context provided)'}

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
  // Sequential on purpose: parallel calls burn the per-minute token budget at once.
  const results: ReviewComment[][] = [];
  for (const d of diffs) results.push(await reviewDiff(d));
  return results.flat();
}