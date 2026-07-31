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
   * URL del formulario de checkout, solo informativa (queda en el estado del contacto y en logs).
   * El botón CTA no resuelve variables del estado: usa el enlace corto `/c/:tenantId/:phone`,
   * que redirige a esta misma URL leyéndola de la sesión.
   */
  checkoutUrl?: string;
}

export function emptyBbcWebhookResponse(): BbcWebhookAgentResponse {
  return { route: 'none' };
}
