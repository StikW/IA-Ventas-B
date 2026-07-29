import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Document } from '../../domain/entities/Document';
import {
  DocumentStatus,
  IEmbeddingProvider,
  IStorageService,
  IVectorStore,
} from '../../domain/ports/KnowledgePorts';
import { IDocumentRepository } from '../../domain/repositories/IDocumentRepository';
import { DocumentParserFactory } from '../../infrastructure/parsers/DocumentParserFactory';
import { DocumentProcessorService } from './DocumentProcessorService';

vi.mock('../../../../shared/infrastructure/config/env', () => ({
  hasOpenAI: true,
  env: {},
}));

const tenantId = 'tenant-xyz';
const docId = 'doc-proc-1';

function makeDocument(): Document {
  return Document.create(
    {
      tenantId,
      filename: 'manual.txt',
      mimeType: 'text/plain',
      size: 100,
      storageKey: `tenants/${tenantId}/documents/${docId}/manual.txt`,
      status: DocumentStatus.UPLOADED,
      chunkCount: 0,
      vectorCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    docId
  );
}

describe('DocumentProcessorService', () => {
  let documentRepo: IDocumentRepository;
  let storage: IStorageService;
  let vectorStore: IVectorStore;
  let embeddingProvider: IEmbeddingProvider;
  let parserFactory: DocumentParserFactory;
  let service: DocumentProcessorService;

  beforeEach(() => {
    documentRepo = {
      save: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      findByTenant: vi.fn(),
      delete: vi.fn(),
    };
    storage = {
      save: vi.fn(),
      read: vi.fn().mockResolvedValue(Buffer.from('Texto de prueba para vectorizar.')),
      delete: vi.fn(),
      deleteTenantFiles: vi.fn(),
    };
    vectorStore = {
      upsert: vi.fn(),
      query: vi.fn(),
      deleteByDocument: vi.fn(),
      deleteNamespace: vi.fn(),
    };
    embeddingProvider = {
      embed: vi.fn().mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        model: 'text-embedding-3-small',
        dimensions: 3,
      }),
    };
    parserFactory = {
      getParser: vi.fn().mockReturnValue({
        supports: () => true,
        extract: vi.fn().mockResolvedValue('Texto de prueba para vectorizar.'),
      }),
    } as unknown as DocumentParserFactory;

    service = new DocumentProcessorService(
      documentRepo,
      storage,
      vectorStore,
      embeddingProvider,
      parserFactory
    );
  });

  it('vectoriza: lee storage, parsea, embede y upsert en Pinecone/local', async () => {
    const document = makeDocument();

    const result = await service.process(document);

    expect(storage.read).toHaveBeenCalledWith(document.storageKey);
    expect(parserFactory.getParser).toHaveBeenCalledWith('text/plain', 'manual.txt');
    expect(embeddingProvider.embed).toHaveBeenCalledOnce();
    expect(vectorStore.deleteByDocument).toHaveBeenCalledWith(tenantId, docId);
    expect(vectorStore.upsert).toHaveBeenCalledOnce();

    const upsertArgs = vi.mocked(vectorStore.upsert).mock.calls[0];
    expect(upsertArgs[0]).toBe(tenantId);
    expect(upsertArgs[1][0].id).toBe(`${docId}#0`);
    expect(upsertArgs[1][0].metadata.documentId).toBe(docId);

    expect(result.status).toBe(DocumentStatus.READY);
    expect(result.chunkCount).toBe(1);
    expect(result.vectorCount).toBe(1);
  });

  it('marca FAILED si el documento no tiene texto extraíble', async () => {
    vi.mocked(parserFactory.getParser).mockReturnValue({
      supports: () => true,
      extract: vi.fn().mockResolvedValue('   '),
    });

    const document = makeDocument();

    await expect(service.process(document)).rejects.toThrow('No se extrajo texto del documento');

    const failedUpdate = vi.mocked(documentRepo.update).mock.calls.at(-1)?.[0] as Document;
    expect(failedUpdate.status).toBe(DocumentStatus.FAILED);
  });

  it('elimina vectores previos antes de re-upsert (reprocess)', async () => {
    const document = makeDocument();
    const callOrder: string[] = [];

    vi.mocked(vectorStore.deleteByDocument).mockImplementation(async () => {
      callOrder.push('delete');
    });
    vi.mocked(vectorStore.upsert).mockImplementation(async () => {
      callOrder.push('upsert');
    });

    await service.process(document);

    expect(callOrder).toEqual(['delete', 'upsert']);
  });
});
