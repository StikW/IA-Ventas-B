import { BuilderBotButtonOption } from '../../builderbot/domain/IBuilderBotCloudService';
import { BbcUiRoute } from '../../builderbot/domain/BbcWebhookAgentResponse';
import { CATALOG_CTA_LABEL } from './catalogUrl.utils';
import { WA_BTN } from './whatsappFlow.constants';

type OutboundWhatsAppMessage =
  | { kind: 'text'; body: string }
  | { kind: 'image'; body: string; imageUrl: string }
  | { kind: 'buttons'; body: string; footer?: string; buttons: BuilderBotButtonOption[] }
  | { kind: 'cta_url'; body: string; ctaBody?: string; displayText: string; url: string; footer?: string };

function hasButton(message: OutboundWhatsAppMessage, id: string): boolean {
  return message.kind === 'buttons' && message.buttons.some((btn) => btn.id === id);
}

/**
 * Elige el flow UI que BBC debe ejecutar tras los mensajes de texto del agente.
 *
 * Solo ciertos momentos usan flows UI:
 * - *Vaciar carrito* al saludar con carrito (`cart`).
 * - *Finalizar pedido* tras agregar/modificar carrito (`finalize`).
 * - *Ver catálogo* en discovery o consultas de catálogo (`catalog`).
 *
 * El enlace de checkout no tiene flow: la URL cambia por conversación y el CTA URL del
 * panel no resuelve variables.
 */
export function resolveBbcUiRoute(
  outbound: OutboundWhatsAppMessage | OutboundWhatsAppMessage[]
): BbcUiRoute {
  const messages = Array.isArray(outbound) ? outbound : [outbound];

  if (messages.some((message) => hasButton(message, WA_BTN.CART_CLEAR))) return 'cart';

  if (messages.some((message) => hasButton(message, WA_BTN.CART_FINALIZE))) return 'finalize';

  const usesCatalogCta = messages.some(
    (message) => message.kind === 'cta_url' && message.displayText === CATALOG_CTA_LABEL
  );
  if (usesCatalogCta) return 'catalog';

  return 'none';
}
