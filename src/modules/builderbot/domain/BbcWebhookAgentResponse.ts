/** Respuesta que BuilderBot Cloud consume vía add_http (rules + messageMapping). */
export type BbcUiRoute = 'payment' | 'text' | 'none';

export interface BbcWebhookAgentResponse {
  route: BbcUiRoute;
  /** Texto plano cuando route === 'text'. Vacío si BBC envía el flow UI de pago con botones. */
  message?: string;
}

export function emptyBbcWebhookResponse(): BbcWebhookAgentResponse {
  return { route: 'none', message: '' };
}
