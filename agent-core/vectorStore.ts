import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';
import { config } from './config.js';

const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'; // small, fast, runs fully local

let embedder: FeatureExtractionPipeline | null = null;

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedder) {
    // First call downloads the model (~90MB) once and caches it locally.
    // No API key, no network dependency after the first download.
    embedder = (await pipeline(
      'feature-extraction',
      EMBEDDING_MODEL
    )) as FeatureExtractionPipeline;
  }
  return embedder;
}

/**
 * Turns a chunk of code into an embedding vector, entirely locally —
 * no external API, no cost. Runs on CPU; fine for the scale of this project.
 */
export async function embed(text: string): Promise<number[]> {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

export interface CodeChunk {
  id: string;
  filePath: string;
  content: string;
}

interface StoredChunk extends CodeChunk {
  embedding: number[];
}

// In-memory store, lazily loaded from the JSON file on disk. At this repo's
// scale (~48 chunks) there's no reason to run a separate vector database —
// the whole store fits comfortably in memory and loads in milliseconds.
let store: StoredChunk[] | null = null;

async function loadStore(): Promise<StoredChunk[]> {
  if (store) return store;
  try {
    const raw = await fs.readFile(config.vectorStorePath, 'utf-8');
    store = JSON.parse(raw) as StoredChunk[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      store = [];
    } else {
      throw err;
    }
  }
  return store;
}

async function saveStore(chunks: StoredChunk[]): Promise<void> {
  await fs.mkdir(path.dirname(config.vectorStorePath), { recursive: true });
  await fs.writeFile(config.vectorStorePath, JSON.stringify(chunks), 'utf-8');
  store = chunks;
}

/**
 * Computes embeddings for the given chunks and writes them to the JSON
 * store on disk (replacing any previous contents). Meant to be run once
 * (or whenever the target repo changes materially) via `npm run index-repo`
 * — the resulting file is small enough to commit to the repo, so the
 * webhook listener never needs to recompute embeddings at request time.
 */
export async function indexChunks(chunks: CodeChunk[]): Promise<void> {
  const BATCH_SIZE = 20;
  const results: StoredChunk[] = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const embeddings = await Promise.all(batch.map((c) => embed(c.content)));
    batch.forEach((c, j) => results.push({ ...c, embedding: embeddings[j] }));
    console.log(`Embedded ${Math.min(i + BATCH_SIZE, chunks.length)} / ${chunks.length} chunks`);
  }

  await saveStore(results);
  console.log(`Saved ${results.length} embeddings to ${config.vectorStorePath}`);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RetrievedChunk {
  content: string;
  filePath: string;
  distance: number;
}

/**
 * Brute-force cosine similarity search over the in-memory store. At ~48
 * chunks this is effectively instant; it would need to become an ANN index
 * (or a real vector DB) only if the target repo grew into the tens of
 * thousands of chunks.
 */
export async function retrieveRelevantChunks(
  query: string,
  topK = 5
): Promise<RetrievedChunk[]> {
  const chunks = await loadStore();
  if (chunks.length === 0) return [];

  const queryEmbedding = await embed(query);

  const scored = chunks.map((c) => ({
    content: c.content,
    filePath: c.filePath,
    similarity: cosineSimilarity(queryEmbedding, c.embedding),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, topK).map((c) => ({
    content: c.content,
    filePath: c.filePath,
    // Kept as "distance" to match the previous interface (lower = closer);
    // cosine similarity is inverted here so callers don't need to change.
    distance: 1 - c.similarity,
  }));
}
