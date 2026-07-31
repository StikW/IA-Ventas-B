import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { env } from './shared/infrastructure/config/env';
import { logger } from './shared/infrastructure/logger/logger';
import { correlationIdMiddleware } from './shared/presentation/middlewares/correlationId';
import { errorHandler, notFoundHandler } from './shared/presentation/middlewares/errorHandler';
import { createAuthRoutes, createUserRoutes } from './shared/presentation/routes/identity.routes';
import { createBusinessRoutes } from './shared/presentation/routes/tenant.routes';
import {
  createConfigRoutes,
  createDocumentRoutes,
  createKnowledgeRoutes,
} from './shared/presentation/routes/knowledge.routes';
import {
  createWooCommerceRoutes,
  createOrderRoutes,
  createBuilderBotRoutes,
} from './shared/presentation/routes/commerce.routes';
import { createBuilderBotTenantRoutes } from './shared/presentation/routes/builderbot.routes';
import { createWebhookRoutes } from './shared/presentation/routes/webhook.routes';
import { checkoutRedirectController } from './modules/sales-agent/presentation/controllers/CheckoutRedirectController';

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'IA Ventas API',
      version: '0.1.0',
      description: 'Plataforma SaaS Multi-Tenant - API',
    },
    servers: [{ url: `http://localhost:${env.PORT}${env.API_PREFIX}` }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    },
  },
  apis: [],
});

export function createApp(): express.Application {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(correlationIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      customProps: (req) => ({
        correlationId: req.headers['x-correlation-id'],
      }),
      customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
      customErrorMessage: (req, res, err) =>
        `${req.method} ${req.url} → ${res.statusCode} (${err.message})`,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    })
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  // Enlace del botón "Continuar compra" (BBC no resuelve variables en URLs de botones).
  // Se expone también bajo API_PREFIX porque el proxy puede enrutar solo `/api/*` al backend.
  const checkoutRedirect = checkoutRedirectController.redirect.bind(checkoutRedirectController);
  app.get('/c/:tenantId/:phone', checkoutRedirect);

  const api = express.Router();
  api.get('/c/:tenantId/:phone', checkoutRedirect);
  api.use('/auth', createAuthRoutes());
  api.use('/users', createUserRoutes());
  api.use('/businesses', createBusinessRoutes());
  api.use('/config', createConfigRoutes());
  api.use('/documents', createDocumentRoutes());
  api.use('/knowledge', createKnowledgeRoutes());
  api.use('/woocommerce', createWooCommerceRoutes());
  api.use('/builderbot', createBuilderBotTenantRoutes());
  api.use('/orders', createOrderRoutes());
  api.use('/channel', createBuilderBotRoutes());
  api.use('/webhooks', createWebhookRoutes());

  app.use(env.API_PREFIX, api);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
