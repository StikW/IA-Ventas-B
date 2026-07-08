import { Request, Response, NextFunction } from 'express';
import { container } from 'tsyringe';
import {
  ConnectBuilderBotPhoneUseCase,
  GetBuilderBotConfigUseCase,
  GetBuilderBotQrUseCase,
  LinkBuilderBotBotUseCase,
  ProvisionWhatsAppUseCase,
  RefreshBuilderBotStatusUseCase,
} from '../../application/use-cases/BuilderBotUseCases';

export class BuilderBotController {
  async getConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(GetBuilderBotConfigUseCase);
      const result = await useCase.execute({ actor: req.user! });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async getQr(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(GetBuilderBotQrUseCase);
      const result = await useCase.execute({ actor: req.user! });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async connectPhone(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(ConnectBuilderBotPhoneUseCase);
      const result = await useCase.execute({ actor: req.user!, phone: req.body.phone });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async refreshStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(RefreshBuilderBotStatusUseCase);
      const result = await useCase.execute({ actor: req.user! });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async linkBot(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(LinkBuilderBotBotUseCase);
      const result = await useCase.execute({ actor: req.user!, botId: req.body.botId });
      res.status(201).json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async provision(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(ProvisionWhatsAppUseCase);
      const result = await useCase.execute({ actor: req.user! });
      res.status(result ? 201 : 200).json({ data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const builderBotController = new BuilderBotController();
