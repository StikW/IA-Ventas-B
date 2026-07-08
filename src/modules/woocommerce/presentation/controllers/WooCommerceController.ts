import { Request, Response, NextFunction } from 'express';
import { container } from 'tsyringe';
import {
  GetWooCommerceConfigUseCase,
  ListWooCommerceProductsUseCase,
  TestWooCommerceConnectionUseCase,
  UpdateWooCommerceConfigUseCase,
} from '../../application/use-cases/WooCommerceUseCases';

export class WooCommerceController {
  async getConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(GetWooCommerceConfigUseCase);
      const result = await useCase.execute({ actor: req.user! });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async updateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(UpdateWooCommerceConfigUseCase);
      const result = await useCase.execute({ actor: req.user!, ...req.body });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async testConnection(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(TestWooCommerceConnectionUseCase);
      const result = await useCase.execute({ actor: req.user! });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async listProducts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(ListWooCommerceProductsUseCase);
      const result = await useCase.execute({
        actor: req.user!,
        page: req.query.page ? Number(req.query.page) : 1,
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const wooCommerceController = new WooCommerceController();
