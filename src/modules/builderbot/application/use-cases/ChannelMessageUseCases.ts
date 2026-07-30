import { inject, injectable } from 'tsyringe';
import { UseCase } from '../../../../shared/application/UseCase';
import {
  SendWhatsAppTextInput,
  WhatsAppOutboundService,
} from '../services/WhatsAppOutboundService';

@injectable()
export class SendChannelMessageUseCase
  implements UseCase<SendWhatsAppTextInput & { tenantId: string }, { phone: string; sentAt: string }>
{
  constructor(@inject(WhatsAppOutboundService) private readonly outbound: WhatsAppOutboundService) {}

  execute(input: SendWhatsAppTextInput & { tenantId: string }) {
    return this.outbound.sendText(input);
  }
}
