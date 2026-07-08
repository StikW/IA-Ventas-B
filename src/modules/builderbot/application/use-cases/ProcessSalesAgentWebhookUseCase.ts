import { inject, injectable } from 'tsyringe';
import { UseCase } from '../../../../shared/application/UseCase';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { SalesAgentService } from '../../../sales-agent/application/services/SalesAgentService';

export interface IncomingWebhookMessage {
  from: string;
  text: string;
  messageId?: string;
  messageType?: string;
}

@injectable()
export class ProcessSalesAgentWebhookUseCase
  implements
    UseCase<
      {
        tenantId: string;
        deviceId: string;
        messages: IncomingWebhookMessage[];
      },
      { processed: number; replied: number }
    >
{
  constructor(@inject(SalesAgentService) private readonly salesAgent: SalesAgentService) {}

  async execute(input: {
    tenantId: string;
    deviceId: string;
    messages: IncomingWebhookMessage[];
  }): Promise<{ processed: number; replied: number }> {
    let replied = 0;

    for (const message of input.messages) {
      if (!message.from || !message.text?.trim()) continue;
      if (message.messageType && message.messageType !== 'text') continue;

      try {
        const result = await this.salesAgent.handleIncomingMessage({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: message.from,
          text: message.text,
          messageId: message.messageId,
        });

        if (result.replied) replied += 1;
      } catch (err) {
        logger.error(
          {
            err,
            tenantId: input.tenantId,
            customerPhone: message.from,
            messageId: message.messageId,
          },
          'Error procesando mensaje del agente de ventas'
        );
      }
    }

    return { processed: input.messages.length, replied };
  }
}
