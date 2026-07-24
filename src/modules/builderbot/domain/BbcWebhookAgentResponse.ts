/** Respuesta que BuilderBot Cloud consume vía add_http (rules + messageMapping). */
export type BbcUiRoute = 'payment' | 'text' | 'none';

export interface BbcWebhookAgentResponse {
  route: BbcUiRoute;
  /** Texto plano cuando route === 'text'. No enviar en route payment (BBC duplicaría mensaje). */
  reply?: string;
}

export function emptyBbcWebhookResponse(): BbcWebhookAgentResponse {
  return { route: 'none' };
}
