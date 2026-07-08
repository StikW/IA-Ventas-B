import { z } from 'zod';

export const connectPhoneSchema = z.object({
  phone: z
    .string()
    .trim()
    .min(8)
    .max(20)
    .regex(/^\+?[0-9]+$/, 'Usa formato internacional, ej: +573001234567'),
});

export const linkBotSchema = z.object({
  botId: z
    .string()
    .trim()
    .min(8)
    .max(80)
    .regex(/^[a-zA-Z0-9-]+$/, 'ID de bot inválido'),
});
