import { inject, injectable } from 'tsyringe';
import { UseCase } from '../../../../shared/application/UseCase';
import { ValidationError } from '../../../../shared/domain/errors/DomainError';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { normalizeBuilderBotPhone } from '../../infrastructure/builderBotPhone';
import { IChatSessionRepository } from '../../../sales-agent/domain/IChatSessionRepository';

export interface ClearWhatsAppCartInput {
  tenantId: string;
  phone: string;
  reason?: string;
}

@injectable()
export class ClearWhatsAppCartUseCase
  implements UseCase<ClearWhatsAppCartInput, { cleared: boolean; phone: string }>
{
  constructor(@inject('IChatSessionRepository') private readonly chatRepo: IChatSessionRepository) {}

  async execute(input: ClearWhatsAppCartInput): Promise<{ cleared: boolean; phone: string }> {
    const phone = normalizeBuilderBotPhone(input.phone);
    if (phone.replace(/\D/g, '').length < 10) {
      throw new ValidationError('Número de teléfono inválido');
    }

    const session = await this.chatRepo.find(input.tenantId, phone);
    const hadCart = (session?.salesContext?.cartItems?.length ?? 0) > 0;

    if (!session) {
      return { cleared: false, phone };
    }

    await this.chatRepo.save({
      tenantId: input.tenantId,
      customerPhone: phone,
      messages: session.messages ?? [],
      salesContext: {
        phase: 'browsing',
        flowStep: 'discovery',
        cartItems: [],
        customerName: session.salesContext?.customerName,
        lastOrderId: session.salesContext?.lastOrderId,
        massiWooOrderId: session.salesContext?.massiWooOrderId,
        massiWooOrderNumber: session.salesContext?.massiWooOrderNumber,
        massiTicketCode: session.salesContext?.massiTicketCode,
      },
      updatedAt: new Date().toISOString(),
    });

    logger.info(
      {
        tenantId: input.tenantId,
        phone,
        hadCart,
        reason: input.reason ?? 'manual',
      },
      'Carrito WhatsApp vaciado tras compra'
    );

    return { cleared: hadCart, phone };
  }
}
