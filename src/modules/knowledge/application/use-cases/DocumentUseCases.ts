import { inject, injectable } from 'tsyringe';
import { TenantContext, UseCase } from '../../../../shared/application/UseCase';
import { ForbiddenError, NotFoundError } from '../../../../shared/domain/errors/DomainError';
import { generateId } from '../../../../shared/infrastructure/utils/crypto.utils';
import { UserRole } from '../../../identity/domain/entities/User.types';
import { Document } from '../../domain/entities/Document';
import { DocumentStatus, IStorageService, IVectorStore } from '../../domain/ports/KnowledgePorts';
import { IDocumentRepository } from '../../domain/repositories/IDocumentRepository';
import { DocumentProcessorService } from '../services/DocumentProcessorService';

const ALLOWED_MIMES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

function resolveTenantId(actor: TenantContext): string {
  if (actor.role === UserRole.NEGOCIO && actor.tenantId) return actor.tenantId;
  throw new ForbiddenError('Solo usuarios NEGOCIO pueden gestionar documentos');
}

@injectable()
export class UploadDocumentUseCase
  implements UseCase<{ actor: TenantContext; file: Express.Multer.File }, ReturnType<Document['toJSON']>>
{
  constructor(
    @inject('IDocumentRepository') private readonly documentRepo: IDocumentRepository,
    @inject('IStorageService') private readonly storage: IStorageService,
    @inject(DocumentProcessorService) private readonly processor: DocumentProcessorService
  ) {}

  async execute(input: { actor: TenantContext; file: Express.Multer.File }) {
    const tenantId = resolveTenantId(input.actor);
    const file = input.file;

    if (!ALLOWED_MIMES.includes(file.mimetype) && !file.originalname.match(/\.(pdf|docx|txt)$/i)) {
      throw new ForbiddenError('Tipo de archivo no permitido. Use PDF, DOCX o TXT');
    }

    const id = generateId();
    const now = new Date().toISOString();
    const storageRef = await this.storage.save(tenantId, id, file.originalname, file.buffer);

    let document = Document.create(
      {
        tenantId,
        filename: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        storageKey: storageRef.key,
        status: DocumentStatus.UPLOADED,
        chunkCount: 0,
        vectorCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      id
    );

    await this.documentRepo.save(document);

    try {
      document = await this.processor.process(document);
    } catch {
      document = (await this.documentRepo.findById(tenantId, id))!;
    }

    return document.toJSON();
  }
}

@injectable()
export class ListDocumentsUseCase {
  constructor(@inject('IDocumentRepository') private readonly documentRepo: IDocumentRepository) {}

  async execute(input: { actor: TenantContext; limit?: number; cursor?: string }) {
    const tenantId = resolveTenantId(input.actor);
    const result = await this.documentRepo.findByTenant(tenantId, {
      limit: input.limit,
      cursor: input.cursor,
    });
    return { ...result, data: result.data.map((d) => d.toJSON()) };
  }
}

@injectable()
export class DeleteDocumentUseCase {
  constructor(
    @inject('IDocumentRepository') private readonly documentRepo: IDocumentRepository,
    @inject('IStorageService') private readonly storage: IStorageService,
    @inject('IVectorStore') private readonly vectorStore: IVectorStore
  ) {}

  async execute(input: { actor: TenantContext; id: string }) {
    const tenantId = resolveTenantId(input.actor);
    const doc = await this.documentRepo.findById(tenantId, input.id);
    if (!doc) throw new NotFoundError('Documento no encontrado');

    await this.vectorStore.deleteByDocument(tenantId, input.id);
    await this.storage.delete(doc.storageKey);
    await this.documentRepo.delete(tenantId, input.id);
  }
}

@injectable()
export class ReprocessDocumentUseCase {
  constructor(
    @inject('IDocumentRepository') private readonly documentRepo: IDocumentRepository,
    @inject(DocumentProcessorService) private readonly processor: DocumentProcessorService
  ) {}

  async execute(input: { actor: TenantContext; id: string }) {
    const tenantId = resolveTenantId(input.actor);
    const doc = await this.documentRepo.findById(tenantId, input.id);
    if (!doc) throw new NotFoundError('Documento no encontrado');

    const processed = await this.processor.process(doc);
    return processed.toJSON();
  }
}
