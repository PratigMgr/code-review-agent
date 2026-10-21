import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type Express } from 'express';
import { groqChatStream, SYSTEM_PROMPT as REVIEWER_PROMPT, type ChatMessage } from '../agent-core/reviewer.js';
import { evalCases } from '../eval-harness/test-cases.js';

interface StoredCase { caseId: string; passed: boolean; notes: string[] }
interface StoredRun {
  timestamp: string;
  model: string;
  retrieval: boolean;
  passed: number;
  total: number;
  cases: StoredCase[];
}

const RESULTS_PATH = path.resolve('data/eval-results.json');
const MAX_CONTEXT_CHARS = 11_000; // ~2.8k tokens: richer answers while staying under Groq's per-minute limit
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const hadApiError = (r: StoredRun) => r.cases.some((c) => c.notes.some((n) => n.startsWith('Threw an error')));

// ---------- Two lanes ----------
// General lane: any normal question. A strong model, no eval data attached.
// Project lane: questions about evals, retrieval, the reviewer prompt. Eval data attached.
const PROJECT_WORDS = /\b(evals?|retrieval|flaky|reviewer|false alarms?|planted|webhook|severity|clean-\w+|(test|failing|failed|missed|all|my) cases?|my (scores?|results?|runs?|prompt)|latest (scores?|results?|runs?))\b/i;
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile';

const GENERAL_RULES = `You are "Groq assistant", a smart, friendly and knowledgeable AI assistant that lives in the dashboard of a code-review agent.

How to behave:
- Talk naturally, like a thoughtful person. Answer greetings and small talk warmly and briefly, then keep the conversation going.
- Answer any question well: coding, science, writing, math, career, everyday topics. Be accurate and give real substance: explain your reasoning, add an example or code when it helps, and structure longer answers with short paragraphs or bullets.
- Match the length to the question: a sentence or two for simple things, a thorough answer for complex ones.
- If you are not sure, or the answer needs real-time information you cannot see (you cannot browse the web), say so honestly instead of guessing.
- If the request is ambiguous, ask one short clarifying question.
- If the user wants facts about their eval scores, test cases or the reviewer prompt, ask them to ask about that directly so you can look at the saved data.`;

async function loadRuns(): Promise<StoredRun[]> {
  try {
    return JSON.parse(await fs.readFile(RESULTS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

/** Snapshot of the eval data for the assistant: most useful facts first, reviewer prompt last. */
export function buildContext(allRuns: StoredRun[], question = ''): string {
  // Send only what this question needs: fewer tokens = faster answers and more questions per minute.
  const wantsFix = /prompt|fix|chang|improv|rule|bullet|instruct|why|fail|wrong|miss|false alarm|better|solve/i.test(question);
  const wantsCatalog = /\blist\b|all (the )?(test )?cases|every (test|case)|test cases|what tests|how many/i.test(question);

  if (allRuns.length === 0) {
    return 'No eval runs have been saved yet. The user needs to run "npm run eval -- --both" first.\n\nTHE REVIEWER\'S CURRENT SYSTEM PROMPT:\n' + REVIEWER_PROMPT;
  }

  const runs = allRuns.filter((r) => !hadApiError(r));
  const hidden = allRuns.length - runs.length;
  const latest = (flag: boolean) => [...runs].reverse().find((r) => r.retrieval === flag);
  const lOn = latest(true);
  const lOff = latest(false);
  const isClean = (id: string) => !!evalCases.find((c) => c.id === id)?.expectNoIssues;
  const pct = (r: StoredRun) => Math.round((r.passed / r.total) * 100) + '%';
  const split = (r: StoredRun) => {
    const bugs = r.cases.filter((c) => !isClean(c.caseId));
    const clean = r.cases.filter((c) => isClean(c.caseId));
    return `bugs caught ${bugs.filter((c) => c.passed).length}/${bugs.length}, clean code left alone ${clean.filter((c) => c.passed).length}/${clean.length}`;
  };

  const out: string[] = [];

  // 1. Headline summary
  out.push('SUMMARY:');
  out.push(`- ${allRuns.length} runs saved, ${runs.length} valid${hidden ? `, ${hidden} excluded because they hit API errors such as rate limits (their scores are meaningless)` : ''}.`);
  out.push(`- Model: ${(lOn || lOff)?.model ?? 'unknown'}. Total test cases: ${evalCases.length}.`);
  if (lOn) out.push(`- Latest retrieval ON: ${lOn.passed}/${lOn.total} (${pct(lOn)}), ${split(lOn)}.`);
  if (lOff) out.push(`- Latest retrieval OFF: ${lOff.passed}/${lOff.total} (${pct(lOff)}), ${split(lOff)}.`);
  if (lOn && lOff) {
    const d = lOn.passed - lOff.passed;
    out.push(`- Retrieval effect: ${d === 0 ? 'no difference' : (d > 0 ? '+' : '') + d + ' case(s)'} (ON minus OFF).`);
  }

  // 2. History
  out.push('\nRUN HISTORY (valid runs, oldest to newest):');
  for (const r of runs.slice(-12)) out.push(`- ${r.timestamp.slice(0, 16).replace('T', ' ')} retrieval=${r.retrieval ? 'ON' : 'OFF'} ${r.passed}/${r.total}`);

  // 3. Failures in the latest runs, with the grader's notes
  const failingIds = new Set<string>();
  for (const [label, r] of [['ON', lOn], ['OFF', lOff]] as const) {
    if (!r) { out.push(`\nLATEST RETRIEVAL ${label}: not run yet`); continue; }
    const failed = r.cases.filter((c) => !c.passed);
    out.push(`\nFAILURES, LATEST RETRIEVAL ${label}: ${failed.length === 0 ? 'none, every case passed' : ''}`);
    for (const c of failed) {
      failingIds.add(c.caseId);
      out.push(`- ${c.caseId}${isClean(c.caseId) ? ' [clean code, false alarm]' : ' [planted bug, missed or wrong]'}: ${clip(c.notes.join(' | '), 350)}`);
    }
  }

  // 4. Cases that differ between ON and OFF
  if (lOn && lOff) {
    const diffs = lOn.cases.filter((c) => lOff.cases.find((o) => o.caseId === c.caseId)?.passed !== c.passed);
    out.push('\nCASES WHERE RETRIEVAL ON AND OFF DISAGREE: ' + (diffs.length
      ? diffs.map((c) => `${c.caseId} (${c.passed ? 'ON passes, OFF fails' : 'ON fails, OFF passes'})`).join('; ')
      : 'none'));
  }

  // 5. Flaky vs consistently failing, across all valid runs
  const stats = new Map<string, { pass: number; total: number }>();
  for (const r of runs) for (const c of r.cases) {
    const s = stats.get(c.caseId) ?? { pass: 0, total: 0 };
    s.total++; if (c.passed) s.pass++;
    stats.set(c.caseId, s);
  }
  const flaky = [...stats].filter(([, v]) => v.pass > 0 && v.pass < v.total).map(([id, v]) => `${id} (${v.pass}/${v.total})`);
  const always = [...stats].filter(([, v]) => v.pass === 0 && v.total > 1).map(([id, v]) => `${id} (0/${v.total})`);
  out.push(`\nFLAKY CASES (pass sometimes, across valid runs): ${flaky.join(', ') || 'none'}`);
  out.push(`ALWAYS FAILING CASES: ${always.join(', ') || 'none'}`);

  // 6. Definitions of the failing cases (only when asking why / how to fix)
  if (wantsFix && failingIds.size) {
    out.push('\nDEFINITIONS OF FAILING CASES:');
    for (const id of failingIds) {
      const tc = evalCases.find((c) => c.id === id);
      if (!tc) continue;
      const expect = tc.expectNoIssues
        ? 'expects NO comments (clean code)'
        : 'expects: ' + tc.expectedIssues.map((e) => `keywords [${e.mustMentionKeywords.join(', ')}] at severity >= ${e.minSeverity}`).join('; ');
      out.push(`- ${id} (${tc.description}) ${expect}\n  diff:\n${clip(tc.diff.patch, 400)}`);
    }
  }

  // 7. Catalogue of every test case (only when asked to list / count them)
  if (wantsCatalog) {
    out.push('\nALL TEST CASES:');
    for (const tc of evalCases) out.push(`- ${tc.id} [${tc.expectNoIssues ? 'clean' : 'bug'}]: ${clip(tc.description, 70)}`);
  }

  // Keep the reviewer prompt whole (suggested fixes must match it) and trim the rest to fit.
  const promptBlock = wantsFix
    ? '\n\nTHE REVIEWER\'S CURRENT SYSTEM PROMPT:\n' + REVIEWER_PROMPT
    : '\n\n(Reviewer prompt omitted to save tokens. If the user wants a prompt change, tell them to ask for the fix.)';
  const room = Math.max(3_000, MAX_CONTEXT_CHARS - promptBlock.length);
  return clip(out.join('\n'), room) + promptBlock;
}

const ASSISTANT_RULES = `You are "Groq assistant", the helper inside the dashboard of an AI code-review agent. You help the developer understand eval results and improve the agent.

HOW THE SYSTEM WORKS:
- A GitHub webhook sends a pull request. The agent fetches the diff, optionally retrieves related code chunks from a local vector store ("retrieval"), asks a Groq LLM to review it with the system prompt, and posts inline comments.
- The eval harness grades the reviewer on labeled cases. Cases named "clean-*" are correct code and must get NO comments (clean code left alone). All others contain a planted bug that must be flagged with the right keywords at the right severity (bugs caught).
- "Retrieval ON/OFF" compares reviews with and without extra repo context. Runs that hit API errors are excluded as meaningless.

REPLY FORMAT (always use these exact headings, and skip a section that does not apply):
### Answer
One or two sentences with the direct answer.
### Evidence
2 to 4 one-line bullets: scores, case IDs, grader notes. Bold the key numbers.
### Fix
Only if something should change: the exact bullet to add to the reviewer prompt in a fenced code block, then one line on false-alarm risk.
### Next step
One line.

STYLE RULES:
- No greeting, no restating the question, no closing remarks. Maximum about 150 words.
- A simple factual question gets only "### Answer" in 1 to 3 sentences. A greeting gets one line.
- General programming or prompt questions: answer from general knowledge, briefly, and skip Evidence and Fix.
- A difference of 1 or 2 cases between runs is likely noise: say so instead of declaring a winner.
- For facts about this project use ONLY the DATA below. If it lacks the answer, say what is missing and how to get it (for example, run "npm run eval -- --both"). Never invent scores, cases or results.

DATA:
`;

// ---------- Instant answers: common questions computed straight from the data (no model call) ----------
function analyze(allRuns: StoredRun[]) {
  const runs = allRuns.filter((r) => !hadApiError(r));
  const latest = (flag: boolean) => [...runs].reverse().find((r) => r.retrieval === flag);
  const isClean = (id: string) => !!evalCases.find((c) => c.id === id)?.expectNoIssues;
  const split = (r: StoredRun) => {
    const bugs = r.cases.filter((c) => !isClean(c.caseId));
    const clean = r.cases.filter((c) => isClean(c.caseId));
    return `bugs caught ${bugs.filter((c) => c.passed).length}/${bugs.length}, clean code left alone ${clean.filter((c) => c.passed).length}/${clean.length}`;
  };
  const stats = new Map<string, { pass: number; total: number }>();
  for (const r of runs) for (const c of r.cases) {
    const st = stats.get(c.caseId) ?? { pass: 0, total: 0 };
    st.total++; if (c.passed) st.pass++;
    stats.set(c.caseId, st);
  }
  return { runs, excluded: allRuns.length - runs.length, lOn: latest(true), lOff: latest(false), split, stats };
}

/** Returns a ready-made answer for simple "what are the numbers" questions, or null to let the model answer. */
export function quickAnswer(question: string, allRuns: StoredRun[]): string | null {
  const q = question.trim();
  if (q.length > 120 || allRuns.length === 0) return null;
  if (!PROJECT_WORDS.test(q)) return null; // only answer questions that are really about the evals
  // Anything that needs reasoning (causes, fixes, explanations) goes to the model.
  // Word boundaries so "should" inside other words doesn't accidentally match.
  if (/\b(why|fix|prompt|chang\w*|improv\w*|rule|how does|how do|explain|suggest|should)\b/i.test(q)) return null;

  const isFlaky = /flaky|inconsistent|unstable|unreliable/i.test(q);
  const isRetrieval = /retrieval/i.test(q) && /worth|help|useful|better|matter|compare|effect|vs/i.test(q);
  const isSummary = /\b(summari[sz]e|summary|overview|latest results?|current results?|scores?)\b/i.test(q);
  if (!isFlaky && !isRetrieval && !isSummary) return null;

  const a = analyze(allRuns);
  if (!a.lOn && !a.lOff) return null;
  const pct = (r: StoredRun) => Math.round((r.passed / r.total) * 100) + '%';
  const score = (r: StoredRun) => r.passed + '/' + r.total + ' (' + pct(r) + ')';
  const failing = (r?: StoredRun) => (r ? r.cases.filter((c) => !c.passed).map((c) => c.caseId) : []);
  const excluded = a.excluded ? '\n- ' + a.excluded + ' run(s) were excluded because they hit API errors (rate limits), so their scores mean nothing' : '';

  if (isFlaky) {
    const flaky = [...a.stats].filter(([, v]) => v.pass > 0 && v.pass < v.total).sort((x, y) => x[1].pass / x[1].total - y[1].pass / y[1].total);
    const always = [...a.stats].filter(([, v]) => v.pass === 0 && v.total > 1).map(([id]) => id);
    if (flaky.length === 0 && always.length === 0) {
      return '### Answer\nNo flaky cases: every case gave the same result in all ' + a.runs.length + ' valid runs.';
    }
    return '### Answer\n**' + flaky.length + '** case(s) pass in some runs and fail in others across ' + a.runs.length + ' valid runs.\n\n### Evidence\n' +
      flaky.slice(0, 8).map(([id, v]) => '- `' + id + '`: passed ' + v.pass + ' of ' + v.total + ' runs').join('\n') +
      (flaky.length > 8 ? '\n- and ' + (flaky.length - 8) + ' more' : '') +
      (always.length ? '\n- Always failing: ' + always.map((i) => '`' + i + '`').join(', ') : '') +
      excluded + '\n\n### Next step\nAsk "Give me the exact prompt change to fix them" to tighten the borderline rules.';
  }

  if (isRetrieval) {
    if (!a.lOn || !a.lOff) {
      return '### Answer\nI can only compare once both modes have a valid run.\n\n### Next step\nRun `npm run eval -- --both`.';
    }
    const d = a.lOn.passed - a.lOff.passed;
    const verdict = Math.abs(d) <= 2
      ? 'No clear difference: ON ' + score(a.lOn) + ' vs OFF ' + score(a.lOff) + '. A gap of 1 or 2 cases is within normal run-to-run noise.'
      : d > 0 ? 'Retrieval **helps**: ON ' + score(a.lOn) + ' vs OFF ' + score(a.lOff) + '.'
              : 'Retrieval **hurts**: ON ' + score(a.lOn) + ' vs OFF ' + score(a.lOff) + '.';
    const off = new Map(a.lOff.cases.map((c) => [c.caseId, c.passed]));
    const disagree = a.lOn.cases.filter((c) => off.get(c.caseId) !== c.passed)
      .map((c) => '- `' + c.caseId + '`: ' + (c.passed ? 'ON passes, OFF fails' : 'ON fails, OFF passes'));
    return '### Answer\n' + verdict + '\n\n### Evidence\n- ON: ' + a.split(a.lOn) + '\n- OFF: ' + a.split(a.lOff) + '\n' +
      (disagree.length ? disagree.join('\n') : '- Both modes pass and fail the same cases') + excluded +
      '\n\n### Next step\nRe-run `npm run eval -- --both` once or twice more before deciding; retrieval also makes each run slower.';
  }

  // summary
  const lines: string[] = [];
  if (a.lOn) lines.push('- **Retrieval ON:** ' + a.split(a.lOn) + (failing(a.lOn).length ? '. Failing: ' + failing(a.lOn).map((i) => '`' + i + '`').join(', ') : '. Nothing failing'));
  if (a.lOff) lines.push('- **Retrieval OFF:** ' + a.split(a.lOff) + (failing(a.lOff).length ? '. Failing: ' + failing(a.lOff).map((i) => '`' + i + '`').join(', ') : '. Nothing failing'));
  const anyFail = failing(a.lOn).length + failing(a.lOff).length > 0;
  return '### Answer\n' + [a.lOn && 'Retrieval ON scored **' + score(a.lOn) + '**', a.lOff && 'retrieval OFF scored **' + score(a.lOff) + '**'].filter(Boolean).join(' and ') + ' in the latest valid runs.\n\n### Evidence\n' +
    lines.join('\n') + excluded + '\n\n### Next step\n' +
    (anyFail ? 'Ask "Why did the failing cases fail?" for the causes and an exact prompt fix.' : 'Everything passes. Re-run the evals after any prompt change to catch regressions.');
}

// Remembers answers to repeated questions. The key includes the data, so new eval results never reuse stale answers.
const answerCache = new Map<string, string>();

function sendWhole(res: import('express').Response, text: string, source: 'instant' | 'cache'): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Answer-Source', source);
  res.end(text);
}

export function registerChat(app: Express): void {
  app.post('/dashboard/chat', express.json({ limit: '50kb' }), async (req, res) => {
    const raw: unknown[] = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const history: ChatMessage[] = raw
      .slice(-8)
      .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m: any) => ({ role: m.role, content: clip(m.content, 2000) }));

    if (history.length === 0 || history[history.length - 1].role !== 'user') {
      res.status(400).json({ error: 'Send at least one user message.' });
      return;
    }

    const abort = new AbortController();
    res.on('close', () => abort.abort()); // stop paying for tokens if the user closes the tab
    let started = false;
    try {
      const last = history[history.length - 1].content;
      const runs = await loadRuns();

      // Simple "what are the numbers" questions are computed straight from the data (no model call).
      const instant = quickAnswer(last, runs);
      if (instant) { sendWhole(res, instant, 'instant'); return; }

      // Pick the lane. Project questions get the eval data; everything else is normal conversation.
      const needsData = PROJECT_WORDS.test(last);
      const msgs = history;
      // Use only the latest message to decide what data to attach, so an old "why" or "fix" doesn't pull in the big prompt.
      const system = needsData ? ASSISTANT_RULES + buildContext(runs, last) : GENERAL_RULES;

      const cacheKey = createHash('sha1').update(system + JSON.stringify(msgs)).digest('hex');
      const cached = needsData ? answerCache.get(cacheKey) : undefined; // chat stays fresh; only data answers are cached
      if (cached) { sendWhole(res, cached, 'cache'); return; }
      let full = '';
      await groqChatStream(
        [{ role: 'system', content: system }, ...msgs],
        (text) => {
          if (!started) {
            started = true;
            res.status(200);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('X-Accel-Buffering', 'no'); // tell proxies not to hold the stream back
            res.flushHeaders();
          }
          full += text;
          res.write(text);
        },
        {
          model: CHAT_MODEL,
          maxTokens: needsData ? 1000 : 1400,
          temperature: needsData ? 0.3 : 0.6, // a little warmer for natural conversation
          maxRetries: 2,
          maxWaitMs: 15_000, // never sit silently for a long rate-limit wait
          signal: abort.signal,
        }
      );
      if (!started) {
        res.status(502).json({ error: 'The model returned an empty answer. Please try again.' });
        return;
      }
      if (needsData && full.trim() && !/⚠ The answer was cut off/.test(full)) {
        if (answerCache.size >= 40) answerCache.delete(answerCache.keys().next().value as string);
        answerCache.set(cacheKey, full);
      }
      res.end();
    } catch (err) {
      if (abort.signal.aborted) return; // the user left; nothing to send
      console.error('[dashboard chat]', err);
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = /429|rate.?limit|tokens per minute/i.test(msg)
        ? "Groq's per-minute token limit was hit. Wait about 30 seconds and ask again."
        : clip(msg, 400);
      if (started) {
        res.write('\n\n⚠ The answer was cut off: ' + friendly);
        res.end();
      } else {
        res.status(/429|rate.?limit|tokens per minute/i.test(msg) ? 429 : 502).json({ error: friendly });
      }
    }
  });
}
