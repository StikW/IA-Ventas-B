import { BuilderBotButtonOption } from '../../builderbot/domain/IBuilderBotCloudService';
import { BbcUiRoute } from '../../builderbot/domain/BbcWebhookAgentResponse';
import { WA_BTN } from './whatsappFlow.constants';

type OutboundWhatsAppMessage =
  | { kind: 'text'; body: string }
  | { kind: 'buttons'; body: string; footer?: string; buttons: BuilderBotButtonOption[] };

export function resolveBbcUiRoute(outbound: OutboundWhatsAppMessage): BbcUiRoute {
  if (outbound.kind === 'text') return 'text';

  const buttonIds = outbound.buttons.map((btn) => btn.id ?? btn.body);
  if (buttonIds.some((id) => id === WA_BTN.PAY_TRANSFER || id === WA_BTN.PAY_CASH || id === WA_BTN.MENU_BACK)) {
    return 'payment';
  }

  return 'menu';
}
