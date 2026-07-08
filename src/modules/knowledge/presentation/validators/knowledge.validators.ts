import { z } from 'zod';

export const updateBusinessConfigSchema = z.object({
  description: z.string().max(2000).optional(),
  address: z.string().max(500).optional(),
  businessHours: z.string().max(500).optional(),
  bankAccountInfo: z.string().max(1000).optional(),
});

export const knowledgeSearchSchema = z.object({
  query: z.string().min(1).max(2000),
  topK: z.number().min(1).max(20).optional(),
  minScore: z.number().min(0).max(1).optional(),
});
