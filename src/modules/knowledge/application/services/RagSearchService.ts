import { inject, injectable } from 'tsyringe';
import { hasOpenAI } from '../../../../shared/infrastructure/config/env';
import { DomainError } from '../../../../shared/domain/errors/DomainError';
import { IEmbeddingProvider, IVectorStore } from '../../domain/ports/KnowledgePorts';

export interface RagSearchInput {
  tenantId: string;
  query: string;
  topK?: number;
  minScore?: number;
}

export interface RagSearchResult {
  query: string;
  results: Array<{
    score: number;
    content: string;
    source: string;
    documentId: string;
    chunkIndex: number;
  }>;
}

@injectable()
export class RagSearchService {
  constructor(
    @inject('IVectorStore') private readonly vectorStore: IVectorStore,
    @inject('IEmbeddingProvider') private readonly embeddingProvider: IEmbeddingProvider
  ) {}

  async search(input: RagSearchInput): Promise<RagSearchResult> {
    if (!hasOpenAI) {
      throw new DomainError(
        'OPENAI_API_KEY requerida para búsqueda RAG. Configúrala en .env',
        'OPENAI_NOT_CONFIGURED'
      );
    }

    const topK = input.topK ?? 5;
    const minScore = input.minScore ?? 0.5;

    const { embeddings } = await this.embeddingProvider.embed({ texts: [input.query] });
    const matches = await this.vectorStore.query(input.tenantId, embeddings[0], topK);

    return {
      query: input.query,
      results: matches
        .filter((m) => m.score >= minScore)
        .map((m) => ({
          score: m.score,
          content: m.metadata.content,
          source: m.metadata.source,
          documentId: m.metadata.documentId,
          chunkIndex: m.metadata.chunkIndex,
        })),
    };
  }
}
