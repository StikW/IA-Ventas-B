import { Request, Response, NextFunction } from 'express';
import { container } from 'tsyringe';
import { CreateOrderUseCase, GetOrderUseCase, GetTenantMetricsUseCase, ListOrdersUseCase, UpdateOrderStatusUseCase } from '../../application/use-cases/OrderUseCases';
import { GetWooCommerceStockUseCase, ListWooCommerceProductsUseCase } from '../../../woocommerce/application/use-cases/WooCommerceUseCases';

export class OrderController {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(ListOrdersUseCase);
      const result = await useCase.execute({
        actor: req.user!,
        status: req.query.status as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        cursor: req.query.cursor as string | undefined,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(GetOrderUseCase);
      const result = await useCase.execute({ actor: req.user!, id: String(req.params.id) });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(CreateOrderUseCase);
      const tenantId = req.user?.tenantId ?? req.apiKeyContext?.tenantId;
      if (!tenantId) {
        res.status(400).json({ error: { code: 'TENANT_REQUIRED', message: 'Tenant requerido' } });
        return;
      }
      const result = await useCase.execute({
        tenantId,
        ...req.body,
        actorUserId: req.user?.userId,
      });
      res.status(201).json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async metrics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(GetTenantMetricsUseCase);
      const result = await useCase.execute({ actor: req.user! });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async updateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(UpdateOrderStatusUseCase);
      const result = await useCase.execute({
        actor: req.user!,
        orderId: String(req.params.id),
        status: req.body.status,
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
}

export class CatalogController {
  async listProducts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(ListWooCommerceProductsUseCase);
      const result = await useCase.execute({
        actor: { userId: 'api-key', email: '', role: 'NEGOCIO', tenantId: req.apiKeyContext!.tenantId },
        page: req.query.page ? Number(req.query.page) : 1,
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async getStock(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(GetWooCommerceStockUseCase);
      const result = await useCase.execute({
        tenantId: req.apiKeyContext!.tenantId,
        sku: String(req.params.sku),
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const orderController = new OrderController();
export const catalogController = new CatalogController();
