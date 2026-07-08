import { Request, Response, NextFunction } from 'express';
import { container } from 'tsyringe';
import {
  ActivateBusinessUseCase,
  CreateBusinessUseCase,
  DeactivateBusinessUseCase,
  DeleteBusinessUseCase,
  GetBusinessUseCase,
  ListBusinessesUseCase,
  UpdateBusinessUseCase,
} from '../../application/use-cases/BusinessUseCases';

export class BusinessController {
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(CreateBusinessUseCase);
      const result = await useCase.execute({ ...req.body, actor: req.user! });
      res.status(201).json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(ListBusinessesUseCase);
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
      const useCase = container.resolve(GetBusinessUseCase);
      const result = await useCase.execute({ id: String(req.params.id), actor: req.user! });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(UpdateBusinessUseCase);
      const result = await useCase.execute({ id: String(req.params.id), ...req.body, actor: req.user! });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async activate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(ActivateBusinessUseCase);
      const result = await useCase.execute({ id: String(req.params.id), actor: req.user! });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async deactivate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(DeactivateBusinessUseCase);
      const result = await useCase.execute({ id: String(req.params.id), actor: req.user! });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(DeleteBusinessUseCase);
      const result = await useCase.execute({ id: String(req.params.id), actor: req.user! });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const businessController = new BusinessController();
