import { inject, injectable } from 'tsyringe';
import { UseCase } from '../../../../shared/application/UseCase';
import { ValidationError } from '../../../../shared/domain/errors/DomainError';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { normalizeBuilderBotPhone, whatsappSessionPhoneCandidates } from '../../infrastructure/builderBotPhone';
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

    const session = await this.findSession(input.tenantId, phone);
    const hadCart = (session?.salesContext?.cartItems?.length ?? 0) > 0;

    if (!session) {
      return { cleared: false, phone };
    }

    const sessionPhone = normalizeBuilderBotPhone(session.customerPhone || phone);
    await this.chatRepo.save({
      tenantId: input.tenantId,
      customerPhone: sessionPhone,
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

    return { cleared: hadCart, phone: sessionPhone };
  }

  private async findSession(tenantId: string, phone: string) {
    const found = [];
    for (const candidate of whatsappSessionPhoneCandidates(phone)) {
      const session = await this.chatRepo.find(tenantId, candidate);
      if (session) found.push({ ...session, customerPhone: candidate });
    }

    return found.find((session) => (session.salesContext?.cartItems?.length ?? 0) > 0) ?? found[0] ?? null;
  }
}
