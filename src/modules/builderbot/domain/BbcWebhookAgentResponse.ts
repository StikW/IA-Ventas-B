/** Respuesta que BuilderBot Cloud consume vía add_http (rules de enrutamiento). */
export type BbcUiRoute = 'payment' | 'none';

export interface BbcWebhookAgentResponse {
  route: BbcUiRoute;
}

export function emptyBbcWebhookResponse(): BbcWebhookAgentResponse {
  return { route: 'none' };
}
