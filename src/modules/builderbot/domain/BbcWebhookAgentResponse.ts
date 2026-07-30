/**
 * Respuesta que BuilderBot Cloud consume vía add_http (rules de enrutamiento).
 *
 * Cada ruta apunta a un flow UI cuyos botones se configuran a mano en el panel BBC:
 * la API v2 y el MCP solo admiten texto.
 */
export type BbcUiRoute = 'catalog' | 'cart' | 'none';

export interface BbcWebhookAgentResponse {
  route: BbcUiRoute;
}

export function emptyBbcWebhookResponse(): BbcWebhookAgentResponse {
  return { route: 'none' };
}
