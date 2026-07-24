import { BuilderBotButtonOption } from '../../builderbot/domain/IBuilderBotCloudService';
import { BbcUiRoute } from '../../builderbot/domain/BbcWebhookAgentResponse';
import { WA_BTN } from './whatsappFlow.constants';

type OutboundWhatsAppMessage =
  | { kind: 'text'; body: string }
  | { kind: 'buttons'; body: string; footer?: string; buttons: BuilderBotButtonOption[] };

const PAYMENT_BUTTON_IDS = new Set<string>([WA_BTN.PAY_TRANSFER, WA_BTN.PAY_CASH, WA_BTN.MENU_BACK]);

/** Solo el paso de método de pago legacy usa flow UI con botones en BuilderBot Cloud. */
export function resolveBbcUiRoute(outbound: OutboundWhatsAppMessage): BbcUiRoute {
  if (outbound.kind !== 'buttons') return 'none';
  const usesPaymentFlow = outbound.buttons.some((btn) => PAYMENT_BUTTON_IDS.has(String(btn.id ?? '')));
  return usesPaymentFlow && outbound.buttons.some((btn) => btn.id === WA_BTN.PAY_TRANSFER || btn.id === WA_BTN.PAY_CASH)
    ? 'payment'
    : 'none';
}
