import { BuilderBotButtonOption } from '../../builderbot/domain/IBuilderBotCloudService';
import { BbcUiRoute } from '../../builderbot/domain/BbcWebhookAgentResponse';
import { CATALOG_CTA_LABEL } from './catalogUrl.utils';
import { WA_BTN } from './whatsappFlow.constants';

type OutboundWhatsAppMessage =
  | { kind: 'text'; body: string }
  | { kind: 'buttons'; body: string; footer?: string; buttons: BuilderBotButtonOption[] }
  | { kind: 'cta_url'; body: string; ctaBody?: string; displayText: string; url: string; footer?: string };

function hasButton(message: OutboundWhatsAppMessage, id: string): boolean {
  return message.kind === 'buttons' && message.buttons.some((btn) => btn.id === id);
}

/**
 * Elige el flow UI que BBC debe ejecutar tras los mensajes de texto del agente.
 *
 * Solo el saludo tiene flow, y se distingue por sus botones: *Vaciar carrito* aparece
 * únicamente al saludar con carrito. Tras agregar o modificar productos el agente sigue
 * en texto libre.
 *
 * El checkout tampoco tiene flow: su botón CTA necesita una URL distinta por conversación
 * (`items=SKU:qty&phone=…`) y el panel solo admite URLs fijas.
 */
export function resolveBbcUiRoute(
  outbound: OutboundWhatsAppMessage | OutboundWhatsAppMessage[]
): BbcUiRoute {
  const messages = Array.isArray(outbound) ? outbound : [outbound];

  const usesPaymentFlow = messages.some(
    (message) => hasButton(message, WA_BTN.PAY_TRANSFER) || hasButton(message, WA_BTN.PAY_CASH)
  );
  if (usesPaymentFlow) return 'payment';

  if (messages.some((message) => hasButton(message, WA_BTN.CART_CLEAR))) return 'cart';

  const usesCatalogCta = messages.some(
    (message) => message.kind === 'cta_url' && message.displayText === CATALOG_CTA_LABEL
  );
  if (usesCatalogCta) return 'catalog';

  return 'none';
}
