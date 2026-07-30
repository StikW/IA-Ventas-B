import { inject, injectable } from 'tsyringe';
import { Order } from '../../domain/entities/Order';
import { WhatsAppOutboundService } from '../../../builderbot/application/services/WhatsAppOutboundService';

@injectable()
export class OrderNotificationService {
  constructor(@inject(WhatsAppOutboundService) private readonly outbound: WhatsAppOutboundService) {}

  async notifyPaymentApproved(order: Order): Promise<void> {
    const invoice = order.toJSON().woocommerceOrderNumber ?? order.id;
    const message = [
      '¡Buenas noticias! Tu pago fue validado con éxito.',
      `Tu número de factura/pedido es *#${invoice}*.`,
      'Preséntalo para reclamar tu producto. ¡Gracias por tu compra!',
    ].join('\n');

    try {
      await this.outbound.sendText({
        tenantId: order.tenantId,
        phone: order.toJSON().customerPhone,
        message,
        purpose: 'order_status',
      });
    } catch {
      // El servicio ya registró el error; no interrumpir el flujo del pedido.
    }
  }
}
