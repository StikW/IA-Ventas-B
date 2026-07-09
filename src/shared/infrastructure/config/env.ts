import dotenv from 'dotenv';
import { z } from 'zod';
import { PRODUCTION_APP_ORIGIN } from './appDomain';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  API_PREFIX: z.string().default('/api/v1'),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  DYNAMODB_ENDPOINT: z.string().optional(),
  DYNAMODB_REGION: z.string().default('us-east-1'),
  DYNAMODB_TABLE_NAME: z.string().default('PlatformTable'),
  DYNAMODB_AUDIT_TABLE_NAME: z.string().default('AuditLogTable'),
  CORS_ORIGIN: z.string().default(isProduction ? PRODUCTION_APP_ORIGIN : 'http://localhost:4200'),
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
  // Storage local (desarrollo)
  STORAGE_PATH: z.string().default('./storage'),
  // OpenAI — solo embeddings en plataforma
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  OPENAI_CHAT_MODEL: z.string().default('gpt-4o-mini'),
  // Pinecone — opcional; si no hay, usa almacén local de vectores
  PINECONE_API_KEY: z.string().optional(),
  PINECONE_INDEX: z.string().optional(),
  PINECONE_HOST: z.string().optional(),
  // AWS S3 — opcional para producción
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  // BuilderBot — wa-api (console.builderbot.app): auto-provision device + QR
  BUILDERBOT_API_MODE: z.enum(['auto', 'wa-api', 'cloud-v2']).default('wa-api'),
  BUILDERBOT_API_URL: z.string().url().optional(),
  BUILDERBOT_API_KEY: z.string().optional(),
  BUILDERBOT_WEBHOOK_SECRET: z.string().optional(),
  BUILDERBOT_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  APP_PUBLIC_URL: z.string().url().default(isProduction ? PRODUCTION_APP_ORIGIN : 'http://localhost:3000'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const hasOpenAI = !!env.OPENAI_API_KEY;
export const hasPinecone = !!(env.PINECONE_API_KEY && env.PINECONE_INDEX);
export const hasS3 = !!(env.S3_BUCKET && env.AWS_REGION);
export const hasBuilderBot = !!env.BUILDERBOT_API_KEY;
export const useLocalDynamoDb = !!env.DYNAMODB_ENDPOINT;
