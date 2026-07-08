import { Router } from 'express';
import multer from 'multer';
import { configController } from '../../../modules/tenant/presentation/controllers/ConfigController';
import {
  documentController,
  knowledgeController,
} from '../../../modules/knowledge/presentation/controllers/KnowledgeController';
import { updateBusinessConfigSchema, knowledgeSearchSchema } from '../../../modules/knowledge/presentation/validators/knowledge.validators';
import { authMiddleware, requireRole, tenantMiddleware } from '../middlewares/auth.middleware';
import { apiKeyMiddleware } from '../middlewares/apiKey.middleware';
import { validateBody } from '../middlewares/validate.middleware';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

export function createConfigRoutes(): Router {
  const router = Router();

  router.use(authMiddleware);
  router.use(tenantMiddleware);

  router.get('/', requireRole('ADMIN', 'NEGOCIO'), configController.getConfig.bind(configController));
  router.put(
    '/business',
    requireRole('ADMIN', 'NEGOCIO'),
    validateBody(updateBusinessConfigSchema),
    configController.updateBusiness.bind(configController)
  );
  router.get('/api-key', requireRole('ADMIN', 'NEGOCIO'), configController.getApiKeyInfo.bind(configController));
  router.post(
    '/api-key/regenerate',
    requireRole('ADMIN', 'NEGOCIO'),
    configController.regenerateApiKey.bind(configController)
  );

  return router;
}

export function createDocumentRoutes(): Router {
  const router = Router();

  router.use(authMiddleware);
  router.use(requireRole('NEGOCIO'));
  router.use(tenantMiddleware);

  router.get('/', documentController.list.bind(documentController));
  router.post('/', upload.single('file'), documentController.upload.bind(documentController));
  router.delete('/:id', documentController.delete.bind(documentController));
  router.post('/:id/reprocess', documentController.reprocess.bind(documentController));

  return router;
}

/** API consumida por BuilderBot — autenticación con X-API-Key */
export function createKnowledgeRoutes(): Router {
  const router = Router();

  router.use(apiKeyMiddleware);
  router.post('/search', validateBody(knowledgeSearchSchema), knowledgeController.search.bind(knowledgeController));

  return router;
}
