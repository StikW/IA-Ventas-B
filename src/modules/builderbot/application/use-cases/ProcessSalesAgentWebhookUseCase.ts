import { inject, injectable } from 'tsyringe';
import { UseCase } from '../../../../shared/application/UseCase';
import { BbcWebhookAgentResponse, emptyBbcWebhookResponse } from '../../domain/BbcWebhookAgentResponse';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { SalesAgentService } from '../../../sales-agent/application/services/SalesAgentService';

export interface IncomingWebhookMessage {
  from: string;
  text: string;
  messageId?: string;
  messageType?: string;
}

export interface IncomingWebhookImage {
  from: string;
  messageId?: string;
  messageType?: string;
  mediaUrl?: string;
  caption?: string;
}

@injectable()
export class ProcessSalesAgentWebhookUseCase
  implements
    UseCase<
      {
        tenantId: string;
        deviceId: string;
        messages: IncomingWebhookMessage[];
        images: IncomingWebhookImage[];
      },
      { processed: number; replied: number; bbcResponse: BbcWebhookAgentResponse }
    >
{
  constructor(@inject(SalesAgentService) private readonly salesAgent: SalesAgentService) {}

  async execute(input: {
    tenantId: string;
    deviceId: string;
    messages: IncomingWebhookMessage[];
    images: IncomingWebhookImage[];
  }): Promise<{ processed: number; replied: number; bbcResponse: BbcWebhookAgentResponse }> {
    let replied = 0;
    let processed = 0;
    let bbcResponse = emptyBbcWebhookResponse();

    for (const message of input.messages) {
      if (!message.from || !message.text?.trim()) continue;
      if (message.messageType && !['text', 'interactive', 'button', 'buttons_response', 'list_response'].includes(message.messageType.toLowerCase())) continue;
      processed += 1;

      try {
        const result = await this.salesAgent.handleIncomingMessage({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: message.from,
          text: message.text,
          messageId: message.messageId,
        });

        if (result.replied) {
          replied += 1;
          if (result.bbcResponse) bbcResponse = result.bbcResponse;
        } else {
          logger.warn(
            { tenantId: input.tenantId, customerPhone: message.from, reason: result.reason },
            'Agente no respondió al mensaje de WhatsApp'
          );
        }
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

        try {
          const fallback = await this.salesAgent.sendProcessingErrorReply({
            tenantId: input.tenantId,
            deviceId: input.deviceId,
            customerPhone: message.from,
            text: message.text,
            messageId: message.messageId,
          });
          if (fallback.replied) {
            replied += 1;
            if (fallback.bbcResponse) bbcResponse = fallback.bbcResponse;
          }
        } catch (fallbackErr) {
          logger.error(
            { err: fallbackErr, tenantId: input.tenantId, customerPhone: message.from },
            'No se pudo enviar respuesta de error al cliente WhatsApp'
          );
        }
      }
    }

    for (const image of input.images) {
      if (!image.from) continue;
      processed += 1;

      try {
        const result = await this.salesAgent.handleIncomingImage({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: image.from,
          imageUrl: image.mediaUrl,
          caption: image.caption,
          messageId: image.messageId,
        });

        if (result.replied) replied += 1;
      } catch (err) {
        logger.error(
          {
            err,
            tenantId: input.tenantId,
            customerPhone: image.from,
            messageId: image.messageId,
          },
          'Error procesando imagen del agente de ventas'
        );
      }
    }

    return { processed, replied, bbcResponse };
  }
}
