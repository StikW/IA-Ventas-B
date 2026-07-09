import 'reflect-metadata';
import { createApp } from './app';
import { env, hasBuilderBot, hasS3, useLocalDynamoDb } from './shared/infrastructure/config/env';
import { registerDependencies } from './shared/infrastructure/di/container';
import { logger } from './shared/infrastructure/logger/logger';
import { resolveBuilderBotApiMode } from './modules/builderbot/infrastructure/builderBotApiMode';

registerDependencies();

if (hasBuilderBot && env.BUILDERBOT_API_KEY?.startsWith('bbc-') && resolveBuilderBotApiMode() === 'wa-api') {
  logger.warn(
    'BUILDERBOT_API_KEY es de app.builderbot.cloud (bbc-). Configura BUILDERBOT_API_MODE=cloud-v2 y BUILDERBOT_API_URL=https://app.builderbot.cloud/api/v1/manager'
  );
}

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      apiPrefix: env.API_PREFIX,
      docs: `http://localhost:${env.PORT}/api-docs`,
      storage: hasS3 ? `s3://${env.S3_BUCKET}` : env.STORAGE_PATH,
      dynamodb: useLocalDynamoDb ? env.DYNAMODB_ENDPOINT : `aws:${env.DYNAMODB_REGION}`,
    },
    'IA Ventas API started'
  );
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error({ port: env.PORT }, 'Puerto en uso. Otro proceso ya escucha en este puerto.');
  } else {
    logger.error({ err }, 'No se pudo iniciar el servidor HTTP');
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  process.exit(1);
});
