export interface BusinessProfileConfig {
  description?: string;
  address?: string;
  businessHours?: string;
  bankAccountInfo?: string;
}

export interface BusinessConfigProps {
  tenantId: string;
  business: BusinessProfileConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  keyHash: string;
  keyPrefix: string;
  createdAt: string;
  revokedAt?: string;
}
