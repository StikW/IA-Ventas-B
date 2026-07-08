import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authController, userController } from '../../../modules/identity/presentation/controllers/AuthController';
import { loginSchema, refreshTokenSchema, createUserSchema, paginationSchema, updateUserSchema } from '../../../modules/identity/presentation/validators/auth.validators';
import { authMiddleware, requireRole } from '../../../shared/presentation/middlewares/auth.middleware';
import { validateBody, validateQuery } from '../../../shared/presentation/middlewares/validate.middleware';

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: { code: 'RATE_LIMIT', message: 'Demasiados intentos' } },
});

export function createAuthRoutes(): Router {
  const router = Router();

  router.post('/login', authLimiter, validateBody(loginSchema), authController.login.bind(authController));
  router.post('/refresh', validateBody(refreshTokenSchema), authController.refresh.bind(authController));
  router.post('/logout', validateBody(refreshTokenSchema), authController.logout.bind(authController));
  router.get('/me', authMiddleware, authController.me.bind(authController));

  return router;
}

export function createUserRoutes(): Router {
  const router = Router();

  router.use(authMiddleware);

  router.get('/', requireRole('ADMIN', 'NEGOCIO'), validateQuery(paginationSchema), userController.list.bind(userController));
  router.post('/', requireRole('ADMIN', 'NEGOCIO'), validateBody(createUserSchema), userController.create.bind(userController));
  router.get('/:id', requireRole('ADMIN', 'NEGOCIO'), userController.getById.bind(userController));
  router.patch('/:id', requireRole('ADMIN', 'NEGOCIO'), validateBody(updateUserSchema), userController.update.bind(userController));
  router.post('/:id/deactivate', requireRole('ADMIN', 'NEGOCIO'), userController.deactivate.bind(userController));

  return router;
}
