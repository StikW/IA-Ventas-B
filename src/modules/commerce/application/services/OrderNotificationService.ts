import { inject, injectable } from 'tsyringe';
import { hasBuilderBot } from '../../../../shared/infrastructure/config/env';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { IBuilderBotCloudService, IBuilderBotConfigRepository } from '../../../builderbot/domain/IBuilderBotCloudService';
import { Order } from '../../domain/entities/Order';

@injectable()
export class OrderNotificationService {
  constructor(
    @inject('IBuilderBotCloudService') private readonly builderBot: IBuilderBotCloudService,
    @inject('IBuilderBotConfigRepository') private readonly builderBotConfigRepo: IBuilderBotConfigRepository
  ) {}

  async notifyPaymentApproved(order: Order): Promise<void> {
    if (!hasBuilderBot) return;

    const config = await this.builderBotConfigRepo.findByTenantId(order.tenantId);
    if (!config?.deviceId) return;

    const invoice = order.toJSON().woocommerceOrderNumber ?? order.id;
    const message = [
      '¡Buenas noticias! Tu pago fue validado con éxito.',
      `Tu número de factura/pedido es *#${invoice}*.`,
      'Preséntalo para reclamar tu producto. ¡Gracias por tu compra!',
    ].join('\n');

    try {
      await this.builderBot.sendTextMessage({
        deviceId: config.deviceId,
        phone: order.toJSON().customerPhone,
        message,
      });
    } catch (err) {
      logger.error(
        { err, tenantId: order.tenantId, orderId: order.id, customerPhone: order.toJSON().customerPhone },
        'No se pudo notificar pago aprobado por WhatsApp'
      );
    }
  }
}
