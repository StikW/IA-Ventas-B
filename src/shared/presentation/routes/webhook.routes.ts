import { Router } from 'express';
import { webhookController } from '../../../modules/builderbot/presentation/controllers/WebhookController';

export function createWebhookRoutes(): Router {
  const router = Router();

  router.get('/builderbot/:tenantId', webhookController.verify.bind(webhookController));
  router.post('/builderbot/:tenantId/order', webhookController.handleOrder.bind(webhookController));
  router.post('/builderbot/:tenantId', webhookController.handle.bind(webhookController));

  return router;
}
