import { Document } from '../entities/Document';
import { PaginatedResult, PaginationInput } from '../../../../shared/application/UseCase';

export interface IDocumentRepository {
  findById(tenantId: string, id: string): Promise<Document | null>;
  findByTenant(tenantId: string, pagination: PaginationInput): Promise<PaginatedResult<Document>>;
  save(document: Document): Promise<void>;
  update(document: Document): Promise<void>;
  delete(tenantId: string, id: string): Promise<void>;
}
