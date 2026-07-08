import { z } from 'zod';
import { UserRole } from '../../domain/entities/User.types';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.nativeEnum(UserRole),
  tenantId: z.string().uuid().optional().nullable(),
  profile: z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().optional(),
  }),
});

export const updateUserSchema = z.object({
  profile: z
    .object({
      firstName: z.string().min(1).optional(),
      lastName: z.string().min(1).optional(),
      phone: z.string().optional(),
    })
    .optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

export const paginationSchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional(),
  cursor: z.string().optional(),
  tenantId: z.string().uuid().optional(),
});
