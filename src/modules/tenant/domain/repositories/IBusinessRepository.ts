import { Business } from '../entities/Business';
import { PaginatedResult, PaginationInput } from '../../../../shared/application/UseCase';

export interface CreateBusinessData {
  name: string;
  slug: string;
  contactEmail: string;
  contactPhone?: string;
  createdBy: string;
}

export interface UpdateBusinessData {
  name?: string;
  slug?: string;
  contactEmail?: string;
  contactPhone?: string;
  status?: string;
  updatedAt: string;
}

export interface IBusinessRepository {
  findById(id: string): Promise<Business | null>;
  findBySlug(slug: string): Promise<Business | null>;
  listByStatus(status: string | null, pagination: PaginationInput): Promise<PaginatedResult<Business>>;
  save(business: Business): Promise<void>;
  update(id: string, data: UpdateBusinessData): Promise<Business>;
}
