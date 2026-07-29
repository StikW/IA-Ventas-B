import { Pinecone } from '@pinecone-database/pinecone';
import { injectable } from 'tsyringe';
import { env } from '../../../../shared/infrastructure/config/env';
import { IVectorStore, QueryResult, VectorRecord } from '../../domain/ports/KnowledgePorts';

@injectable()
export class PineconeVectorStore implements IVectorStore {
  private client: Pinecone;
  private indexName: string;

  constructor() {
    this.client = new Pinecone({ apiKey: env.PINECONE_API_KEY! });
    this.indexName = env.PINECONE_INDEX!;
  }

  private index() {
    return this.client.index(this.indexName);
  }

  private isNotFoundError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return message.includes('404') || (err instanceof Error && err.name === 'PineconeNotFoundError');
  }

  async upsert(namespace: string, vectors: VectorRecord[]): Promise<void> {
    const idx = this.index();
    await idx.namespace(namespace).upsert(
      vectors.map((v) => ({
        id: v.id,
        values: v.values,
        metadata: {
          tenantId: v.metadata.tenantId,
          documentId: v.metadata.documentId,
          chunkIndex: v.metadata.chunkIndex,
          source: v.metadata.source,
          content: v.metadata.content.slice(0, 3500),
          contentPreview: v.metadata.contentPreview,
        },
      }))
    );
  }

  async query(namespace: string, embedding: number[], topK: number): Promise<QueryResult[]> {
    const result = await this.index().namespace(namespace).query({
      vector: embedding,
      topK,
      includeMetadata: true,
    });

    return (result.matches ?? []).map((m) => ({
      id: m.id,
      score: m.score ?? 0,
      metadata: {
        tenantId: (m.metadata?.tenantId as string) ?? namespace,
        documentId: m.metadata?.documentId as string,
        chunkIndex: (m.metadata?.chunkIndex as number) ?? 0,
        source: (m.metadata?.source as string) ?? '',
        content: (m.metadata?.content as string) ?? (m.metadata?.contentPreview as string) ?? '',
        contentPreview: (m.metadata?.contentPreview as string) ?? '',
      },
    }));
  }

  async deleteByDocument(namespace: string, documentId: string): Promise<void> {
    try {
      await this.index().namespace(namespace).deleteMany({ documentId });
    } catch (err) {
      if (this.isNotFoundError(err)) return;
      throw err;
    }
  }

  async deleteNamespace(namespace: string): Promise<void> {
    try {
      await this.index().namespace(namespace).deleteAll();
    } catch (err) {
      if (this.isNotFoundError(err)) return;
      throw err;
    }
  }
}
