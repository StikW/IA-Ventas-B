export enum UserRole {
  ADMIN = 'ADMIN',
  NEGOCIO = 'NEGOCIO',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export interface UserProfile {
  firstName: string;
  lastName: string;
  phone?: string;
}

export interface UserProps {
  email: string;
  passwordHash: string;
  role: UserRole;
  tenantId: string | null;
  status: UserStatus;
  profile: UserProfile;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}
