import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '../../../identity/domain/entities/User.types';
import { Document } from '../../domain/entities/Document';
import { DocumentStatus, IStorageService, IVectorStore } from '../../domain/ports/KnowledgePorts';
import { IDocumentRepository } from '../../domain/repositories/IDocumentRepository';
import { DocumentProcessorService } from '../services/DocumentProcessorService';
import { CatalogTxtGeneratorService } from '../services/CatalogTxtGeneratorService';
import {
  DeleteDocumentUseCase,
  DownloadDocumentUseCase,
  RefreshCatalogDocumentUseCase,
  UploadDocumentUseCase,
} from './DocumentUseCases';

const tenantId = 'tenant-abc';
const actor = { tenantId, userId: 'user-1', role: UserRole.NEGOCIO, email: 'negocio@test.com' };

function makeFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'catalogo.txt',
    encoding: '7bit',
    mimetype: 'text/plain',
    size: 12,
    buffer: Buffer.from('Hola mundo'),
    destination: '',
    filename: '',
    path: '',
    stream: null as unknown as Express.Multer.File['stream'],
    ...overrides,
  };
}

function makeDocument(id = 'doc-1'): Document {
  return Document.create(
    {
      tenantId,
      filename: 'catalogo.txt',
      mimeType: 'text/plain',
      size: 12,
      storageKey: `tenants/${tenantId}/documents/${id}/catalogo.txt`,
      status: DocumentStatus.READY,
      chunkCount: 1,
      vectorCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    id
  );
}

describe('UploadDocumentUseCase', () => {
  let documentRepo: IDocumentRepository;
  let storage: IStorageService;
  let processor: DocumentProcessorService;

  beforeEach(() => {
    documentRepo = {
      save: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      findByTenant: vi.fn(),
      delete: vi.fn(),
    };
    storage = {
      save: vi.fn().mockResolvedValue({
        key: 'tenants/tenant-abc/documents/new-id/catalogo.txt',
        path: 's3://bucket/tenants/tenant-abc/documents/new-id/catalogo.txt',
      }),
      read: vi.fn(),
      delete: vi.fn(),
      deleteTenantFiles: vi.fn(),
    };
    processor = {
      process: vi.fn(),
    } as unknown as DocumentProcessorService;
  });

  it('rechaza tipos de archivo no permitidos', async () => {
    const useCase = new UploadDocumentUseCase(documentRepo, storage, processor);

    await expect(
      useCase.execute({
        actor,
        file: makeFile({ originalname: 'malware.exe', mimetype: 'application/octet-stream' }),
      })
    ).rejects.toThrow('Tipo de archivo no permitido');

    expect(storage.save).not.toHaveBeenCalled();
  });

  it('acepta PDF, DOCX y TXT por MIME o extensión', async () => {
    const useCase = new UploadDocumentUseCase(documentRepo, storage, processor);
    const readyDoc = makeDocument();
    vi.mocked(processor.process).mockResolvedValue(readyDoc);
    vi.mocked(documentRepo.save).mockResolvedValue(undefined);

    const cases = [
      makeFile({ originalname: 'a.pdf', mimetype: 'application/pdf' }),
      makeFile({
        originalname: 'b.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      makeFile({ originalname: 'c.txt', mimetype: 'text/plain' }),
      makeFile({ originalname: 'd.pdf', mimetype: 'application/octet-stream' }),
    ];

    for (const file of cases) {
      vi.clearAllMocks();
      vi.mocked(processor.process).mockResolvedValue(readyDoc);
      await useCase.execute({ actor, file });
      expect(storage.save).toHaveBeenCalledOnce();
    }
  });

  it('guarda en storage, persiste y vectoriza el documento', async () => {
    const useCase = new UploadDocumentUseCase(documentRepo, storage, processor);
    const readyDoc = makeDocument('doc-ready');
    vi.mocked(processor.process).mockResolvedValue(readyDoc);

    const result = await useCase.execute({ actor, file: makeFile() });

    expect(storage.save).toHaveBeenCalledWith(
      tenantId,
      expect.any(String),
      'catalogo.txt',
      expect.any(Buffer)
    );
    expect(documentRepo.save).toHaveBeenCalledOnce();
    expect(processor.process).toHaveBeenCalledOnce();
    expect(result.status).toBe(DocumentStatus.READY);
  });

  it('devuelve documento desde DB si falla la vectorización', async () => {
    const useCase = new UploadDocumentUseCase(documentRepo, storage, processor);
    const failedDoc = makeDocument().withStatus(DocumentStatus.FAILED, {
      errorMessage: 'OpenAI error',
    });

    vi.mocked(processor.process).mockRejectedValue(new Error('OpenAI error'));
    vi.mocked(documentRepo.findById).mockResolvedValue(failedDoc);

    const result = await useCase.execute({ actor, file: makeFile() });

    expect(documentRepo.findById).toHaveBeenCalledOnce();
    expect(result.status).toBe(DocumentStatus.FAILED);
  });
});

describe('DeleteDocumentUseCase', () => {
  let documentRepo: IDocumentRepository;
  let storage: IStorageService;
  let vectorStore: IVectorStore;
  const callOrder: string[] = [];

  beforeEach(() => {
    callOrder.length = 0;
    documentRepo = {
      save: vi.fn(),
      update: vi.fn(),
      findById: vi.fn().mockResolvedValue(makeDocument('doc-del')),
      findByTenant: vi.fn(),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('repo.delete');
      }),
    };
    storage = {
      save: vi.fn(),
      read: vi.fn(),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('storage.delete');
      }),
      deleteTenantFiles: vi.fn(),
    };
    vectorStore = {
      upsert: vi.fn(),
      query: vi.fn(),
      deleteByDocument: vi.fn().mockImplementation(async () => {
        callOrder.push('vector.deleteByDocument');
      }),
      deleteNamespace: vi.fn(),
    };
  });

  it('elimina vectores, archivo en storage y registro en DB', async () => {
    const useCase = new DeleteDocumentUseCase(documentRepo, storage, vectorStore);
    const doc = makeDocument('doc-del');

    await useCase.execute({ actor, id: 'doc-del' });

    expect(vectorStore.deleteByDocument).toHaveBeenCalledWith(tenantId, 'doc-del');
    expect(storage.delete).toHaveBeenCalledWith(doc.storageKey);
    expect(documentRepo.delete).toHaveBeenCalledWith(tenantId, 'doc-del');
    expect(callOrder).toEqual(['vector.deleteByDocument', 'storage.delete', 'repo.delete']);
  });

  it('lanza NotFoundError si el documento no existe', async () => {
    vi.mocked(documentRepo.findById).mockResolvedValue(null);
    const useCase = new DeleteDocumentUseCase(documentRepo, storage, vectorStore);

    await expect(useCase.execute({ actor, id: 'missing' })).rejects.toThrow('Documento no encontrado');
    expect(vectorStore.deleteByDocument).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

describe('RefreshCatalogDocumentUseCase', () => {
  const catalogResult = {
    text: '# Catálogo\n\n---\nProducto: Anillo\nSKU: ANI-1\n',
    stats: { productCount: 1, skuCount: 1, packCount: 0 },
    issues: [],
    issueSummary: [],
  };

  it('genera el catálogo, borra el documento previo y guarda el nuevo', async () => {
    const existing = makeDocument('old-doc');
    const generator = {
      generateForTenant: vi.fn().mockResolvedValue(catalogResult),
    } as unknown as CatalogTxtGeneratorService;
    const deleteDocument = {
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as DeleteDocumentUseCase;
    const uploadDocument = {
      execute: vi.fn().mockResolvedValue(makeDocument('new-doc').toJSON()),
    } as unknown as UploadDocumentUseCase;
    const documentRepo: IDocumentRepository = {
      save: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      findByTenant: vi.fn().mockResolvedValue({ data: [existing], hasMore: false }),
      delete: vi.fn(),
    };

    const useCase = new RefreshCatalogDocumentUseCase(
      generator,
      deleteDocument,
      uploadDocument,
      documentRepo
    );
    const result = await useCase.execute({ actor });

    expect(generator.generateForTenant).toHaveBeenCalledWith(tenantId);
    expect(deleteDocument.execute).toHaveBeenCalledWith({ actor, id: 'old-doc' });
    expect(uploadDocument.execute).toHaveBeenCalledWith({
      actor,
      file: expect.objectContaining({ originalname: 'catalogo.txt', mimetype: 'text/plain' }),
    });
    expect(result.document.id).toBe('new-doc');
    expect(result.catalog.productCount).toBe(1);
  });

  it('si no había documento, solo genera y guarda', async () => {
    const generator = {
      generateForTenant: vi.fn().mockResolvedValue(catalogResult),
    } as unknown as CatalogTxtGeneratorService;
    const deleteDocument = { execute: vi.fn() } as unknown as DeleteDocumentUseCase;
    const uploadDocument = {
      execute: vi.fn().mockResolvedValue(makeDocument('new-doc').toJSON()),
    } as unknown as UploadDocumentUseCase;
    const documentRepo: IDocumentRepository = {
      save: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      findByTenant: vi.fn().mockResolvedValue({ data: [], hasMore: false }),
      delete: vi.fn(),
    };

    const useCase = new RefreshCatalogDocumentUseCase(
      generator,
      deleteDocument,
      uploadDocument,
      documentRepo
    );
    await useCase.execute({ actor });

    expect(deleteDocument.execute).not.toHaveBeenCalled();
    expect(uploadDocument.execute).toHaveBeenCalledOnce();
  });

  it('no borra el documento actual si falla la generación', async () => {
    const generator = {
      generateForTenant: vi.fn().mockRejectedValue(new Error('WooCommerce caído')),
    } as unknown as CatalogTxtGeneratorService;
    const deleteDocument = { execute: vi.fn() } as unknown as DeleteDocumentUseCase;
    const uploadDocument = { execute: vi.fn() } as unknown as UploadDocumentUseCase;
    const documentRepo: IDocumentRepository = {
      save: vi.fn(),
      update: vi.fn(),
      findById: vi.fn(),
      findByTenant: vi.fn(),
      delete: vi.fn(),
    };

    const useCase = new RefreshCatalogDocumentUseCase(
      generator,
      deleteDocument,
      uploadDocument,
      documentRepo
    );

    await expect(useCase.execute({ actor })).rejects.toThrow('WooCommerce caído');
    expect(documentRepo.findByTenant).not.toHaveBeenCalled();
    expect(deleteDocument.execute).not.toHaveBeenCalled();
    expect(uploadDocument.execute).not.toHaveBeenCalled();
  });
});

describe('DownloadDocumentUseCase', () => {
  it('lee el archivo del storage', async () => {
    const documentRepo: IDocumentRepository = {
      save: vi.fn(),
      update: vi.fn(),
      findById: vi.fn().mockResolvedValue(makeDocument('doc-1')),
      findByTenant: vi.fn(),
      delete: vi.fn(),
    };
    const storage: IStorageService = {
      save: vi.fn(),
      read: vi.fn().mockResolvedValue(Buffer.from('catalogo')),
      delete: vi.fn(),
      deleteTenantFiles: vi.fn(),
    };

    const useCase = new DownloadDocumentUseCase(documentRepo, storage);
    const result = await useCase.execute({ actor, id: 'doc-1' });

    expect(storage.read).toHaveBeenCalledWith(`tenants/${tenantId}/documents/doc-1/catalogo.txt`);
    expect(result.filename).toBe('catalogo.txt');
    expect(result.buffer.toString('utf8')).toBe('catalogo');
  });

  it('lanza NotFoundError si el documento no existe', async () => {
    const documentRepo: IDocumentRepository = {
      save: vi.fn(),
      update: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      findByTenant: vi.fn(),
      delete: vi.fn(),
    };
    const storage: IStorageService = {
      save: vi.fn(),
      read: vi.fn(),
      delete: vi.fn(),
      deleteTenantFiles: vi.fn(),
    };

    const useCase = new DownloadDocumentUseCase(documentRepo, storage);
    await expect(useCase.execute({ actor, id: 'missing' })).rejects.toThrow('Documento no encontrado');
    expect(storage.read).not.toHaveBeenCalled();
  });
});
