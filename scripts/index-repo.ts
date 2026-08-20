import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import { simpleGit } from 'simple-git';
import { config } from '../agent-core/config.js';
import { indexChunks, type CodeChunk } from '../agent-core/vectorStore.js';

const CLONE_DIR = './.repo-cache';
const CODE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'java'];
const CHUNK_LINES = 60; // rough chunk size; good enough for a first pass

async function cloneOrPullTarget(): Promise<string> {
  const repoUrl = `https://github.com/${config.targetRepo}.git`;
  const exists = await fs
    .stat(CLONE_DIR)
    .then(() => true)
    .catch(() => false);

  const git = simpleGit();
  if (exists) {
    console.log('Repo cache exists, pulling latest...');
    await simpleGit(CLONE_DIR).pull();
  } else {
    console.log(`Cloning ${repoUrl}...`);
    await git.clone(repoUrl, CLONE_DIR, ['--depth', '1', '--branch', 'main']);
  }
  return CLONE_DIR;
}

function chunkFile(filePath: string, content: string): CodeChunk[] {
  const lines = content.split('\n');
  const chunks: CodeChunk[] = [];

  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const slice = lines.slice(i, i + CHUNK_LINES).join('\n');
    if (slice.trim().length === 0) continue;
    chunks.push({
      id: `${filePath}:${i}`,
      filePath,
      content: slice,
    });
  }
  return chunks;
}

async function main() {
  const repoDir = await cloneOrPullTarget();

  const pattern = `**/*.{${CODE_EXTENSIONS.join(',')}}`;
  const files = await glob(pattern, {
    cwd: repoDir,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/build/**'],
  });

  console.log(`Found ${files.length} source files to index.`);

  const allChunks: CodeChunk[] = [];
  for (const file of files) {
    const fullPath = path.join(repoDir, file);
    const content = await fs.readFile(fullPath, 'utf-8');
    allChunks.push(...chunkFile(file, content));
  }

  console.log(`Chunked into ${allChunks.length} pieces. Indexing into vector store...`);
  await indexChunks(allChunks);
  console.log('Done. The agent now has this repo\'s conventions indexed.');
}

main().catch((err) => {
  console.error('Indexing failed:', err);
  process.exit(1);
});
