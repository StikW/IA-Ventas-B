/**
 * Respuesta que BuilderBot Cloud consume vía add_http (rules de enrutamiento).
 *
 * Cada ruta apunta a un flow UI cuyos botones se configuran a mano en el panel BBC:
 * la API v2 y el MCP solo admiten texto.
 */
export type BbcUiRoute = 'catalog' | 'cart' | 'checkout' | 'none';

export interface BbcWebhookAgentResponse {
  route: BbcUiRoute;
  /**
   * URL del formulario de checkout. BBC fusiona la respuesta en el estado del contacto,
   * así el flow **IA Ventas — Checkout** la usa como `{checkoutUrl}` en su botón CTA
   * (cambia en cada conversación: teléfono + `items=SKU:qty`).
   */
  checkoutUrl?: string;
}

export function emptyBbcWebhookResponse(): BbcWebhookAgentResponse {
  return { route: 'none' };
}
