import { User } from '../entities/User';
import { PaginatedResult, PaginationInput } from '../../../../shared/application/UseCase';

export interface CreateUserData {
  email: string;
  passwordHash: string;
  role: string;
  tenantId: string | null;
  profile: {
    firstName: string;
    lastName: string;
    phone?: string;
  };
}

export interface UpdateUserData {
  profile?: {
    firstName?: string;
    lastName?: string;
    phone?: string;
  };
  status?: string;
  passwordHash?: string;
}

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findByTenant(tenantId: string, pagination: PaginationInput): Promise<PaginatedResult<User>>;
  save(user: User): Promise<void>;
  update(id: string, data: Partial<CreateUserData & UpdateUserData & { lastLoginAt?: string; updatedAt: string }>): Promise<User>;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
}

export interface IRefreshTokenRepository {
  save(record: RefreshTokenRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  revoke(id: string, userId: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}
