import { Request, Response, NextFunction } from 'express';
import { container } from 'tsyringe';
import {
  GetApiKeyInfoUseCase,
  GetConfigUseCase,
  RegenerateApiKeyUseCase,
  UpdateBusinessConfigUseCase,
} from '../../application/use-cases/ConfigUseCases';

export class ConfigController {
  async getConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(GetConfigUseCase);
      const result = await useCase.execute({
        actor: req.user!,
        tenantId: (req.headers['x-tenant-id'] as string) || req.user!.tenantId || undefined,
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async updateBusiness(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(UpdateBusinessConfigUseCase);
      const result = await useCase.execute({
        actor: req.user!,
        tenantId: (req.headers['x-tenant-id'] as string) || req.user!.tenantId || undefined,
        business: req.body,
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async getApiKeyInfo(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(GetApiKeyInfoUseCase);
      const result = await useCase.execute({
        actor: req.user!,
        tenantId: (req.headers['x-tenant-id'] as string) || req.user!.tenantId || undefined,
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async regenerateApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(RegenerateApiKeyUseCase);
      const result = await useCase.execute({
        actor: req.user!,
        tenantId: (req.headers['x-tenant-id'] as string) || req.user!.tenantId || undefined,
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const configController = new ConfigController();
