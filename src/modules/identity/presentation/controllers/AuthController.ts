import { Request, Response, NextFunction } from 'express';
import { container } from 'tsyringe';
import { LoginUseCase } from '../../application/use-cases/LoginUseCase';
import { RefreshTokenUseCase } from '../../application/use-cases/RefreshTokenUseCase';
import { LogoutUseCase } from '../../application/use-cases/LogoutUseCase';
import { CreateUserUseCase, GetUserUseCase, ListUsersUseCase } from '../../application/use-cases/CreateUserUseCase';
import { UpdateUserUseCase, DeactivateUserUseCase } from '../../application/use-cases/UpdateUserUseCase';
import { IUserRepository } from '../../domain/repositories/IUserRepository';
import { NotFoundError } from '../../../../shared/domain/errors/DomainError';

export class AuthController {
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(LoginUseCase);
      const result = await useCase.execute(req.body);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(RefreshTokenUseCase);
      const result = await useCase.execute(req.body);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(LogoutUseCase);
      await useCase.execute(req.body);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }

  async me(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userRepo = container.resolve<IUserRepository>('IUserRepository');
      const user = await userRepo.findById(req.user!.userId);
      if (!user) throw new NotFoundError('Usuario no encontrado');
      res.json({ data: user.toJSON() });
    } catch (err) {
      next(err);
    }
  }
}

export class UserController {
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(CreateUserUseCase);
      const result = await useCase.execute({ ...req.body, actor: req.user! });
      res.status(201).json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(GetUserUseCase);
      const result = await useCase.execute({ id: String(req.params.id), actor: req.user! });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(ListUsersUseCase);
      const result = await useCase.execute({
        actor: req.user!,
        tenantId: (req.query.tenantId as string) || req.user!.tenantId || undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        cursor: req.query.cursor as string | undefined,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(UpdateUserUseCase);
      const result = await useCase.execute({ id: String(req.params.id), actor: req.user!, ...req.body });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async deactivate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(DeactivateUserUseCase);
      const result = await useCase.execute({ id: String(req.params.id), actor: req.user! });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const authController = new AuthController();
export const userController = new UserController();
