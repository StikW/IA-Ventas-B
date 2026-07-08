import { Router } from 'express';
import { businessController } from '../../../modules/tenant/presentation/controllers/BusinessController';
import {
  createBusinessSchema,
  updateBusinessSchema,
  listBusinessesSchema,
} from '../../../modules/tenant/presentation/validators/business.validators';
import { authMiddleware, requireRole, tenantMiddleware } from '../middlewares/auth.middleware';
import { validateBody, validateQuery } from '../middlewares/validate.middleware';

export function createBusinessRoutes(): Router {
  const router = Router();

  router.use(authMiddleware);
  router.use(tenantMiddleware);

  router.get('/', requireRole('ADMIN'), validateQuery(listBusinessesSchema), businessController.list.bind(businessController));
  router.post('/', requireRole('ADMIN'), validateBody(createBusinessSchema), businessController.create.bind(businessController));
  router.get('/:id', requireRole('ADMIN', 'NEGOCIO'), businessController.getById.bind(businessController));
  router.put('/:id', requireRole('ADMIN'), validateBody(updateBusinessSchema), businessController.update.bind(businessController));
  router.post('/:id/activate', requireRole('ADMIN'), businessController.activate.bind(businessController));
  router.post('/:id/deactivate', requireRole('ADMIN'), businessController.deactivate.bind(businessController));
  router.delete('/:id', requireRole('ADMIN'), businessController.delete.bind(businessController));

  return router;
}
