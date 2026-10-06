import { z } from 'zod';

export const updateBusinessConfigSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contactEmail: z.string().trim().email().max(200),
  contactPhone: z.string().trim().max(40).optional(),
  description: z.string().max(2000).optional(),
  address: z.string().max(500).optional(),
  businessHours: z.string().max(500).optional(),
  bankAccountInfo: z.string().max(1000).optional(),
  checkoutFormUrl: z.union([z.string().url().max(2000), z.literal('')]).optional(),
  checkoutMode: z.enum(['link', 'whatsapp']).optional(),
});

export const knowledgeSearchSchema = z.object({
  query: z.string().min(1).max(2000),
  topK: z.number().min(1).max(20).optional(),
  minScore: z.number().min(0).max(1).optional(),
});
