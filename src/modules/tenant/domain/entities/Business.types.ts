export enum BusinessStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  SUSPENDED = 'SUSPENDED',
}

export interface BusinessProps {
  name: string;
  slug: string;
  status: BusinessStatus;
  contactEmail: string;
  contactPhone?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
