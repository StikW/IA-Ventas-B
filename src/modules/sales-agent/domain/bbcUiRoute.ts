import { BuilderBotButtonOption } from '../../builderbot/domain/IBuilderBotCloudService';
import { BbcUiRoute } from '../../builderbot/domain/BbcWebhookAgentResponse';

type OutboundWhatsAppMessage =
  | { kind: 'text'; body: string }
  | { kind: 'buttons'; body: string; footer?: string; buttons: BuilderBotButtonOption[] };

/** Solo el paso de método de pago usa flow UI con botones en BuilderBot Cloud. */
export function resolveBbcUiRoute(outbound: OutboundWhatsAppMessage): BbcUiRoute {
  if (outbound.kind === 'buttons') return 'payment';
  return 'none';
}
