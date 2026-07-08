import fs from 'fs/promises';
import path from 'path';
import { injectable } from 'tsyringe';
import { env } from '../../../../shared/infrastructure/config/env';
import { IVectorStore, QueryResult, VectorRecord } from '../../domain/ports/KnowledgePorts';

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

@injectable()
export class LocalVectorStore implements IVectorStore {
  private basePath = path.resolve(env.STORAGE_PATH, 'vectors');

  private filePath(namespace: string): string {
    return path.join(this.basePath, `${namespace}.json`);
  }

  private async load(namespace: string): Promise<VectorRecord[]> {
    try {
      const raw = await fs.readFile(this.filePath(namespace), 'utf-8');
      return JSON.parse(raw) as VectorRecord[];
    } catch {
      return [];
    }
  }

  private async persist(namespace: string, vectors: VectorRecord[]): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
    await fs.writeFile(this.filePath(namespace), JSON.stringify(vectors));
  }

  async upsert(namespace: string, vectors: VectorRecord[]): Promise<void> {
    const existing = await this.load(namespace);
    const map = new Map(existing.map((v) => [v.id, v]));
    for (const v of vectors) map.set(v.id, v);
    await this.persist(namespace, Array.from(map.values()));
  }

  async query(namespace: string, embedding: number[], topK: number): Promise<QueryResult[]> {
    const vectors = await this.load(namespace);
    return vectors
      .map((v) => ({
        id: v.id,
        score: cosineSimilarity(embedding, v.values),
        metadata: v.metadata,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async deleteByDocument(namespace: string, documentId: string): Promise<void> {
    const vectors = await this.load(namespace);
    const filtered = vectors.filter((v) => v.metadata.documentId !== documentId);
    await this.persist(namespace, filtered);
  }

  async deleteNamespace(namespace: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(namespace));
    } catch {
      // ignore missing namespace file
    }
  }
}
