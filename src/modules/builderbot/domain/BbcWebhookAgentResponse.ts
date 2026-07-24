/** Respuesta que BuilderBot Cloud consume vía add_http (rules + messageMapping). */
export type BbcUiRoute = 'menu' | 'payment' | 'text' | 'none';

export interface BbcWebhookAgentResponse {
  route: BbcUiRoute;
  /** Texto plano cuando route === 'text'. Vacío si BBC envía un flow UI (menú/pago). */
  message?: string;
}

export function emptyBbcWebhookResponse(): BbcWebhookAgentResponse {
  return { route: 'none', message: '' };
}
