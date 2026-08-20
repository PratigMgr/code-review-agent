import 'dotenv/config';
import { Octokit } from '@octokit/rest';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

export const config = {
  githubToken: requireEnv('GITHUB_TOKEN'),
  githubWebhookSecret: requireEnv('GITHUB_WEBHOOK_SECRET'),
  targetRepo: requireEnv('TARGET_REPO'),
  port: Number(process.env.PORT) || 3000,

  // Groq — cloud LLM with a genuine free tier, no card required.
  // https://console.groq.com
  groqApiKey: requireEnv('GROQ_API_KEY'),
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',

  // Built-in vector store — embeddings are computed once (locally, via
  // transformers.js) and persisted to this JSON file, which is committed to
  // the repo and loaded into memory at startup. No separate database
  // service to run or deploy.
  vectorStorePath: process.env.VECTOR_STORE_PATH || './data/embeddings.json',
};

export const octokit = new Octokit({ auth: config.githubToken });
