import { z } from 'zod';

/** Convierte strings vacíos en undefined para campos opcionales. */
function emptyToUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((val) => {
    if (val === null || val === undefined) return undefined;
    if (typeof val === 'string' && val.trim() === '') return undefined;
    return val;
  }, schema);
}

const ownerSchema = z.object({  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  email: emptyToUndefined(z.string().trim().email()).optional(),
  password: z.string().min(8, 'Mínimo 8 caracteres'),
  phone: emptyToUndefined(z.string().trim()).optional(),
});

export const createBusinessSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: emptyToUndefined(
    z.string().trim().min(2).max(60).regex(/^[a-z0-9-]+$/, 'Solo minúsculas, números y guiones')
  ).optional(),
  contactEmail: z.string().trim().email(),
  contactPhone: emptyToUndefined(z.string().trim()).optional(),
  owner: ownerSchema,
});

export const updateBusinessSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  slug: emptyToUndefined(
    z.string().trim().min(2).max(60).regex(/^[a-z0-9-]+$/, 'Solo minúsculas, números y guiones')
  ).optional(),
  contactEmail: z.string().trim().email().optional(),
  contactPhone: emptyToUndefined(z.string().trim()).optional(),
});

export const listBusinessesSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  cursor: z.string().optional(),
});
