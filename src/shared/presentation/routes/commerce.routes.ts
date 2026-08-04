import { Router } from 'express';
import { z } from 'zod';
import { wooCommerceController } from '../../../modules/woocommerce/presentation/controllers/WooCommerceController';
import { orderController, catalogController } from '../../../modules/commerce/presentation/controllers/OrderController';
import { channelController } from '../../../modules/builderbot/presentation/controllers/ChannelController';
import { authMiddleware, requireRole, tenantMiddleware } from '../middlewares/auth.middleware';
import { apiKeyMiddleware } from '../middlewares/apiKey.middleware';
import { validateBody } from '../middlewares/validate.middleware';

const wcConfigSchema = z.object({
  storeUrl: z.string().url(),
  consumerKey: z.string().min(1),
  consumerSecret: z.string().min(1),
});

const createOrderSchema = z.object({
  customerPhone: z.string().min(8),
  customerName: z.string().min(1),
  items: z.array(
    z.object({
      productId: z.number(),
      sku: z.string(),
      name: z.string(),
      quantity: z.number().min(1),
      unitPrice: z.number().min(0),
    })
  ).min(1),
  notes: z.string().optional(),
  syncWooCommerce: z.boolean().optional(),
});

const updateOrderStatusSchema = z.object({
  status: z.enum(['PENDING', 'AWAITING_PAYMENT', 'PAID', 'CONFIRMED', 'CANCELLED']),
});

export function createWooCommerceRoutes(): Router {
  const router = Router();
  router.use(authMiddleware);
  router.use(requireRole('NEGOCIO'));
  router.use(tenantMiddleware);

  router.get('/config', wooCommerceController.getConfig.bind(wooCommerceController));
  router.put('/config', validateBody(wcConfigSchema), wooCommerceController.updateConfig.bind(wooCommerceController));
  router.post('/test-connection', wooCommerceController.testConnection.bind(wooCommerceController));
  router.get('/products', wooCommerceController.listProducts.bind(wooCommerceController));

  return router;
}

export function createOrderRoutes(): Router {
  const router = Router();

  router.get('/', authMiddleware, requireRole('NEGOCIO'), tenantMiddleware, orderController.list.bind(orderController));
  router.get('/metrics/tenant', authMiddleware, requireRole('NEGOCIO'), tenantMiddleware, orderController.metrics.bind(orderController));
  router.get('/:id', authMiddleware, requireRole('NEGOCIO'), tenantMiddleware, orderController.getById.bind(orderController));
  router.patch(
    '/:id/status',
    authMiddleware,
    requireRole('NEGOCIO'),
    tenantMiddleware,
    validateBody(updateOrderStatusSchema),
    orderController.updateStatus.bind(orderController)
  );
  router.post('/', authMiddleware, requireRole('NEGOCIO'), tenantMiddleware, validateBody(createOrderSchema), orderController.create.bind(orderController));

  return router;
}

const sendChannelMessageSchema = z.object({
  phone: z.string().min(8).max(24),
  message: z.string().min(1).max(4096),
  purpose: z.enum(['otp', 'order_status', 'generic']).optional(),
});

const clearChannelCartSchema = z.object({
  phone: z.string().min(8).max(24),
  reason: z.string().max(64).optional(),
});

export function createBuilderBotRoutes(): Router {
  const router = Router();
  router.use(apiKeyMiddleware);

  router.post('/messages', validateBody(sendChannelMessageSchema), channelController.sendMessage.bind(channelController));
  router.post('/cart/clear', validateBody(clearChannelCartSchema), channelController.clearCart.bind(channelController));
  router.post('/orders', validateBody(createOrderSchema), orderController.create.bind(orderController));
  router.get('/catalog/products', catalogController.listProducts.bind(catalogController));
  router.get('/catalog/stock/:sku', catalogController.getStock.bind(catalogController));

  return router;
}
