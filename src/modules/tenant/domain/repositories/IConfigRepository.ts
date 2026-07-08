import { BusinessConfig } from '../entities/BusinessConfig';
import { ApiKeyRecord } from '../entities/Config.types';

export interface IConfigRepository {
  findByTenantId(tenantId: string): Promise<BusinessConfig | null>;
  save(config: BusinessConfig): Promise<void>;
}

export interface IApiKeyRepository {
  findByTenantId(tenantId: string): Promise<ApiKeyRecord | null>;
  findByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  save(record: ApiKeyRecord): Promise<void>;
  revoke(id: string, tenantId: string): Promise<void>;
}
