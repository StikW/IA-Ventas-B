import { Request, Response, NextFunction } from 'express';
import { container } from 'tsyringe';
import { SendChannelMessageUseCase } from '../../application/use-cases/ChannelMessageUseCases';
import { ClearWhatsAppCartUseCase } from '../../application/use-cases/ClearWhatsAppCartUseCase';

export class ChannelController {
  async sendMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = req.apiKeyContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: { code: 'API_KEY_REQUIRED', message: 'API Key requerida' } });
        return;
      }

      const useCase = container.resolve(SendChannelMessageUseCase);
      const result = await useCase.execute({
        tenantId,
        phone: req.body.phone,
        message: req.body.message,
        purpose: req.body.purpose,
      });

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async clearCart(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = req.apiKeyContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: { code: 'API_KEY_REQUIRED', message: 'API Key requerida' } });
        return;
      }

      const useCase = container.resolve(ClearWhatsAppCartUseCase);
      const result = await useCase.execute({
        tenantId,
        phone: req.body.phone,
        reason: req.body.reason ?? 'channel_cart_clear',
      });

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const channelController = new ChannelController();
