import OpenAI from 'openai';
import { injectable } from 'tsyringe';
import { env, hasOpenAI } from '../../../../shared/infrastructure/config/env';
import { DomainError } from '../../../../shared/domain/errors/DomainError';
import { EmbedRequest, EmbedResponse, IEmbeddingProvider } from '../../domain/ports/KnowledgePorts';

@injectable()
export class OpenAIEmbeddingAdapter implements IEmbeddingProvider {
  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    if (!hasOpenAI) {
      throw new DomainError(
        'OPENAI_API_KEY no configurada. Requerida para vectorizar documentos y búsqueda RAG.',
        'OPENAI_NOT_CONFIGURED'
      );
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }
    return this.client;
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    const client = this.getClient();
    const response = await client.embeddings.create({
      model: env.OPENAI_EMBEDDING_MODEL,
      input: request.texts,
    });

    return {
      embeddings: response.data.map((d) => d.embedding),
      model: response.model,
      dimensions: response.data[0]?.embedding.length ?? 0,
    };
  }
}
