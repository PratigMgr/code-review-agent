import express from 'express';
import { Webhooks, createNodeMiddleware } from '@octokit/webhooks';
import { config, octokit } from '../agent-core/config.js';
import { reviewPullRequest, type FileDiff } from '../agent-core/reviewer.js';

const webhooks = new Webhooks({ secret: config.githubWebhookSecret });

webhooks.on('pull_request.opened', handlePullRequest);
webhooks.on('pull_request.synchronize', handlePullRequest);

async function handlePullRequest({ payload }: { payload: any }) {
  const { owner, repo } = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
  };
  const prNumber = payload.pull_request.number;

  console.log(`Reviewing PR #${prNumber} on ${owner}/${repo}`);

  try {
    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
    });

    const diffs: FileDiff[] = files
      .filter((f) => f.patch) // skip binary files / files with no textual diff
      .map((f) => ({ filePath: f.filename, patch: f.patch! }));

    if (diffs.length === 0) {
      console.log('No reviewable text diffs in this PR.');
      return;
    }

    const comments = await reviewPullRequest(diffs);
    console.log(`[handlePullRequest] Got ${comments.length} comments back. Posting to GitHub...`);

    if (comments.length === 0) {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: '🤖 AI review: no issues found relative to repo conventions.',
      });
      console.log('[handlePullRequest] Posted "no issues" comment.');
      return;
    }

    // Post as a single review with inline comments where line numbers are known.
    const inlineComments = comments
      .filter((c) => c.line !== null)
      .map((c) => ({
        path: c.filePath,
        line: c.line as number,
        body: `**[${c.severity}]** ${c.comment}`,
      }));

    const summary = comments
      .map((c) => `- **[${c.severity}]** \`${c.filePath}\`${c.line ? `:${c.line}` : ''} — ${c.comment}`)
      .join('\n');

    console.log('[handlePullRequest] Calling octokit.pulls.createReview...');
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      event: 'COMMENT',
      body: `🤖 AI review summary:\n\n${summary}`,
      comments: inlineComments,
    });

    console.log(`Posted ${comments.length} review comments on PR #${prNumber}`);
  } catch (err) {
    console.error(`Failed to review PR #${prNumber}:`, err);
  }
}

const app = express();
app.use('/webhook', createNodeMiddleware(webhooks, { path: '/' }));
app.get('/health', (_req, res) => res.send('ok'));

app.listen(config.port, () => {
  console.log(`Webhook listener running on port ${config.port}`);
  console.log(`Point your GitHub webhook to: http://<your-host>:${config.port}/webhook`);
});