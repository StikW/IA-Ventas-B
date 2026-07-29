import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VectorRecord } from '../../domain/ports/KnowledgePorts';

const upsertMock = vi.fn();
const queryMock = vi.fn();
const deleteManyMock = vi.fn();
const deleteAllMock = vi.fn();
const namespaceMock = vi.fn(() => ({
  upsert: upsertMock,
  query: queryMock,
  deleteMany: deleteManyMock,
  deleteAll: deleteAllMock,
}));
const indexMock = vi.fn(() => ({ namespace: namespaceMock }));

vi.mock('@pinecone-database/pinecone', () => ({
  Pinecone: class MockPinecone {
    index = indexMock;
  },
}));

vi.mock('../../../../shared/infrastructure/config/env', () => ({
  env: {
    PINECONE_API_KEY: 'pcsk_test',
    PINECONE_INDEX: 'platform-knowledge',
  },
}));

describe('PineconeVectorStore', () => {
  beforeEach(() => {
    upsertMock.mockReset();
    queryMock.mockReset();
    deleteManyMock.mockReset();
    deleteAllMock.mockReset();
    namespaceMock.mockClear();
    indexMock.mockClear();
  });

  it('hace upsert de vectores en el namespace del tenant', async () => {
    upsertMock.mockResolvedValue(undefined);
    const { PineconeVectorStore } = await import('./PineconeVectorStore');
    const store = new PineconeVectorStore();

    const vectors: VectorRecord[] = [
      {
        id: 'doc-1#0',
        values: [0.1, 0.2],
        metadata: {
          tenantId: 'tenant-1',
          documentId: 'doc-1',
          chunkIndex: 0,
          source: 'manual.txt',
          content: 'Texto del chunk',
          contentPreview: 'Texto del chunk',
        },
      },
    ];

    await store.upsert('tenant-1', vectors);

    expect(indexMock).toHaveBeenCalledWith('platform-knowledge');
    expect(namespaceMock).toHaveBeenCalledWith('tenant-1');
    expect(upsertMock).toHaveBeenCalledOnce();
    expect(upsertMock.mock.calls[0][0][0].metadata.documentId).toBe('doc-1');
  });

  it('elimina vectores por documentId con deleteMany', async () => {
    deleteManyMock.mockResolvedValue(undefined);
    const { PineconeVectorStore } = await import('./PineconeVectorStore');
    const store = new PineconeVectorStore();

    await store.deleteByDocument('tenant-1', 'doc-99');

    expect(namespaceMock).toHaveBeenCalledWith('tenant-1');
    expect(deleteManyMock).toHaveBeenCalledWith({ documentId: 'doc-99' });
  });

  it('elimina namespace completo con deleteAll', async () => {
    deleteAllMock.mockResolvedValue(undefined);
    const { PineconeVectorStore } = await import('./PineconeVectorStore');
    const store = new PineconeVectorStore();

    await store.deleteNamespace('tenant-1');

    expect(deleteAllMock).toHaveBeenCalledOnce();
  });
});
