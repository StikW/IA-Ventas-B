import { Request, Response, NextFunction } from 'express';
import { container } from 'tsyringe';
import { env } from '../../../../shared/infrastructure/config/env';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { HandleBuilderBotWebhookUseCase } from '../../application/use-cases/HandleBuilderBotWebhookUseCase';
import { ProcessSalesAgentWebhookUseCase } from '../../application/use-cases/ProcessSalesAgentWebhookUseCase';

function normalizeHeaders(req: Request): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

export class WebhookController {
  async verify(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const mode = String(req.query['hub.mode'] ?? '');
      const token = String(req.query['hub.verify_token'] ?? '');
      const challenge = req.query['hub.challenge'];

      if (
        mode === 'subscribe' &&
        env.BUILDERBOT_WEBHOOK_VERIFY_TOKEN &&
        token === env.BUILDERBOT_WEBHOOK_VERIFY_TOKEN &&
        challenge !== undefined
      ) {
        res.status(200).send(String(challenge));
        return;
      }

      res.status(403).json({
        error: { code: 'WEBHOOK_VERIFY_FAILED', message: 'Verificación de webhook fallida' },
      });
    } catch (err) {
      next(err);
    }
  }

  async handle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(HandleBuilderBotWebhookUseCase);
      const result = await useCase.execute({
        tenantId: String(req.params.tenantId),
        payload: req.body,
        headers: normalizeHeaders(req),
      });

      res.status(200).json({ data: result });

      if (result.incomingMessages.length > 0) {
        const agentUseCase = container.resolve(ProcessSalesAgentWebhookUseCase);
        void agentUseCase
          .execute({
            tenantId: result.tenantId,
            deviceId: result.deviceId,
            messages: result.incomingMessages,
          })
          .catch((err) => {
            logger.error(
              { err, tenantId: result.tenantId, messageCount: result.incomingMessages.length },
              'Error en procesamiento asíncrono del agente de ventas'
            );
          });
      }
    } catch (err) {
      next(err);
    }
  }
}

export const webhookController = new WebhookController();
