import { Router } from 'express';
import { builderBotController } from '../../../modules/builderbot/presentation/controllers/BuilderBotController';
import { connectPhoneSchema, linkBotSchema } from '../../../modules/builderbot/presentation/validators/builderbot.validators';
import { authMiddleware, requireRole, tenantMiddleware } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validate.middleware';

export function createBuilderBotTenantRoutes(): Router {
  const router = Router();
  router.use(authMiddleware);
  router.use(requireRole('NEGOCIO'));
  router.use(tenantMiddleware);

  router.get('/config', builderBotController.getConfig.bind(builderBotController));
  router.post('/link-bot', validateBody(linkBotSchema), builderBotController.linkBot.bind(builderBotController));
  router.post('/provision', builderBotController.provision.bind(builderBotController));
  router.get('/qr', builderBotController.getQr.bind(builderBotController));
  router.post('/connect-phone', validateBody(connectPhoneSchema), builderBotController.connectPhone.bind(builderBotController));
  router.post('/refresh-status', builderBotController.refreshStatus.bind(builderBotController));

  return router;
}
