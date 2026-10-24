import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type Express } from 'express';
import { groqChat, SYSTEM_PROMPT as REVIEWER_PROMPT, type ChatMessage } from '../agent-core/reviewer.js';
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
const MAX_CONTEXT_CHARS = 14_000;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const hadApiError = (r: StoredRun) => r.cases.some((c) => c.notes.some((n) => n.startsWith('Threw an error')));

async function loadRuns(): Promise<StoredRun[]> {
  try {
    return JSON.parse(await fs.readFile(RESULTS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

/** Compact, token-conscious snapshot of the eval data for the assistant. */
function buildContext(allRuns: StoredRun[]): string {
  if (allRuns.length === 0) return 'No eval runs have been saved yet.';

  const runs = allRuns.filter((r) => !hadApiError(r));
  const hidden = allRuns.length - runs.length;
  const latest = (flag: boolean) => [...runs].reverse().find((r) => r.retrieval === flag);
  const lOn = latest(true);
  const lOff = latest(false);

  const out: string[] = [];
  if (hidden) out.push(`(${hidden} run(s) excluded: they hit API errors such as rate limits, so their scores are meaningless.)`);

  out.push('RUN HISTORY (valid runs, oldest to newest):');
  for (const r of runs.slice(-10)) {
    out.push(`- ${r.timestamp} retrieval=${r.retrieval ? 'ON' : 'OFF'} ${r.passed}/${r.total}`);
  }

  const failingIds = new Set<string>();
  for (const [label, r] of [['ON', lOn], ['OFF', lOff]] as const) {
    if (!r) { out.push(`\nLATEST RETRIEVAL ${label}: not run yet`); continue; }
    const failed = r.cases.filter((c) => !c.passed);
    out.push(`\nLATEST RETRIEVAL ${label} (${r.timestamp}, model ${r.model}): ${r.passed}/${r.total} passed`);
    out.push(`Passed: ${r.cases.filter((c) => c.passed).map((c) => c.caseId).join(', ') || 'none'}`);
    for (const c of failed) {
      failingIds.add(c.caseId);
      out.push(`FAILED ${c.caseId}: ${clip(c.notes.join(' | '), 400)}`);
    }
  }

  if (failingIds.size) {
    out.push('\nTEST CASE DEFINITIONS FOR FAILING CASES:');
    for (const id of failingIds) {
      const tc = evalCases.find((c) => c.id === id);
      if (!tc) continue;
      const expect = tc.expectNoIssues
        ? 'expects NO comments (clean code)'
        : 'expects: ' + tc.expectedIssues.map((e) => `keywords [${e.mustMentionKeywords.join(', ')}] at severity >= ${e.minSeverity}`).join('; ');
      out.push(`- ${id} (${tc.description}) ${expect}\n  diff:\n${clip(tc.diff.patch, 500)}`);
    }
  }

  out.push('\nTHE REVIEWER\'S CURRENT SYSTEM PROMPT:\n' + REVIEWER_PROMPT);
  return clip(out.join('\n'), MAX_CONTEXT_CHARS);
}

const ASSISTANT_RULES = `You are the assistant inside the eval dashboard of an AI code-review agent.
The agent reviews GitHub PR diffs with an LLM; an eval harness scores it on labeled cases
(cases named "clean-*" must produce NO comments; the others contain a planted bug that must be flagged).
Answer using ONLY the data below. If the data doesn't contain the answer, say so — never invent scores or results.
Be concise and practical. When you suggest a prompt change, write the exact bullet to add, and mention if it could
cause false alarms on clean cases. Prefer fixing the prompt over weakening a test, unless the test is clearly wrong.
Scores can vary by a case or two between identical runs, so say so when a difference is small.

DATA:
`;

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

    try {
      const system = ASSISTANT_RULES + buildContext(await loadRuns());
      const reply = await groqChat([{ role: 'system', content: system }, ...history], {
        model: process.env.GROQ_CHAT_MODEL || undefined,
      });
      res.json({ reply });
    } catch (err) {
      console.error('[dashboard chat]', err);
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: clip(msg, 400) });
    }
  });
}
