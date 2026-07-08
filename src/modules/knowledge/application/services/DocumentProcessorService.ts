import { inject, injectable } from 'tsyringe';
import { hasOpenAI } from '../../../../shared/infrastructure/config/env';
import { DomainError } from '../../../../shared/domain/errors/DomainError';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { Document } from '../../domain/entities/Document';
import { DocumentStatus, IEmbeddingProvider, IStorageService, IVectorStore, VectorRecord } from '../../domain/ports/KnowledgePorts';
import { IDocumentRepository } from '../../domain/repositories/IDocumentRepository';
import { DocumentParserFactory } from '../../infrastructure/parsers/DocumentParserFactory';
import { chunkText } from '../utils/chunkText';

@injectable()
export class DocumentProcessorService {
  constructor(
    @inject('IDocumentRepository') private readonly documentRepo: IDocumentRepository,
    @inject('IStorageService') private readonly storage: IStorageService,
    @inject('IVectorStore') private readonly vectorStore: IVectorStore,
    @inject('IEmbeddingProvider') private readonly embeddingProvider: IEmbeddingProvider,
    @inject(DocumentParserFactory) private readonly parserFactory: DocumentParserFactory
  ) {}

  async process(document: Document): Promise<Document> {
    if (!hasOpenAI) {
      throw new DomainError(
        'OPENAI_API_KEY requerida para vectorizar documentos. Configúrala en .env',
        'OPENAI_NOT_CONFIGURED'
      );
    }

    let current = document.withStatus(DocumentStatus.PROCESSING);
    await this.documentRepo.update(current);

    try {
      const buffer = await this.storage.read(document.storageKey);
      const parser = this.parserFactory.getParser(document.mimeType, document.filename);
      const text = await parser.extract(buffer, document.filename);

      if (!text.trim()) {
        throw new Error('No se extrajo texto del documento');
      }

      const chunks = chunkText(text);
      const batchSize = 20;
      const allVectors: VectorRecord[] = [];

      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const { embeddings } = await this.embeddingProvider.embed({ texts: batch });

        batch.forEach((content, idx) => {
          const chunkIndex = i + idx;
          allVectors.push({
            id: `${document.id}#${chunkIndex}`,
            values: embeddings[idx],
            metadata: {
              tenantId: document.tenantId,
              documentId: document.id,
              chunkIndex,
              source: document.filename,
              content,
              contentPreview: content.slice(0, 200),
            },
          });
        });
      }

      await this.vectorStore.deleteByDocument(document.tenantId, document.id);
      await this.vectorStore.upsert(document.tenantId, allVectors);

      current = document.withStatus(DocumentStatus.READY, {
        chunkCount: chunks.length,
        vectorCount: allVectors.length,
        processedAt: new Date().toISOString(),
        errorMessage: undefined,
      });

      await this.documentRepo.update(current);
      logger.info({ documentId: document.id, chunks: chunks.length }, 'Document processed');
      return current;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error desconocido';
      current = document.withStatus(DocumentStatus.FAILED, { errorMessage: message });
      await this.documentRepo.update(current);
      throw err;
    }
  }
}
