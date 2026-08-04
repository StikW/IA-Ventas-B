import { inject, injectable } from 'tsyringe';
import { NotFoundError, ValidationError } from '../../../../shared/domain/errors/DomainError';
import { hasBuilderBot } from '../../../../shared/infrastructure/config/env';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { normalizeBuilderBotPhone } from '../../infrastructure/builderBotPhone';
import { IBuilderBotCloudService, IBuilderBotConfigRepository } from '../../domain/IBuilderBotCloudService';
import { ClearWhatsAppCartUseCase } from '../use-cases/ClearWhatsAppCartUseCase';

export type WhatsAppOutboundPurpose = 'otp' | 'order_status' | 'generic';

export interface SendWhatsAppTextInput {
  tenantId: string;
  phone: string;
  message: string;
  purpose?: WhatsAppOutboundPurpose;
}

@injectable()
export class WhatsAppOutboundService {
  constructor(
    @inject('IBuilderBotCloudService') private readonly builderBot: IBuilderBotCloudService,
    @inject('IBuilderBotConfigRepository') private readonly builderBotConfigRepo: IBuilderBotConfigRepository,
    @inject(ClearWhatsAppCartUseCase) private readonly clearWhatsAppCart: ClearWhatsAppCartUseCase
  ) {}

  async sendText(input: SendWhatsAppTextInput): Promise<{ phone: string; sentAt: string }> {
    if (!hasBuilderBot) {
      throw new ValidationError('BuilderBot no está configurado en el servidor');
    }

    const message = input.message.trim();
    if (!message) {
      throw new ValidationError('El mensaje no puede estar vacío');
    }
    if (message.length > 4096) {
      throw new ValidationError('El mensaje supera el límite de 4096 caracteres');
    }

    const phone = normalizeBuilderBotPhone(input.phone);
    if (phone.replace(/\D/g, '').length < 10) {
      throw new ValidationError('Número de teléfono inválido');
    }

    const config = await this.builderBotConfigRepo.findByTenantId(input.tenantId);
    if (!config?.deviceId) {
      throw new NotFoundError('WhatsApp no provisionado para este negocio');
    }

    const sentAt = new Date().toISOString();

    try {
      await this.builderBot.sendTextMessage({
        deviceId: config.deviceId,
        phone,
        message,
      });
    } catch (err) {
      logger.error(
        { err, tenantId: input.tenantId, phone, purpose: input.purpose ?? 'generic' },
        'No se pudo enviar mensaje WhatsApp saliente'
      );
      throw err;
    }

    // Tras notificar estado de pedido, el carrito conversacional ya no aplica.
    if (input.purpose === 'order_status') {
      try {
        await this.clearWhatsAppCart.execute({
          tenantId: input.tenantId,
          phone,
          reason: 'order_status',
        });
      } catch (err) {
        logger.warn(
          { err, tenantId: input.tenantId, phone },
          'No se pudo vaciar el carrito tras order_status'
        );
      }
    }

    logger.info(
      { tenantId: input.tenantId, phone, purpose: input.purpose ?? 'generic' },
      'Mensaje WhatsApp saliente enviado'
    );

    return { phone, sentAt };
  }
}
