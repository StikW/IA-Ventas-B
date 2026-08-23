export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  at: string;
}

export type SalesPhase = 'browsing' | 'awaiting_payment' | 'order_created';

export type ConversationFlowStep =
  | 'menu'
  | 'discovery'
  | 'buying'
  | 'payment_select'
  | 'checkout_redirect'
  | 'help';

export interface PendingCartItem {
  productId: number;
  variationId?: number;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

/**
 * Opción que el agente acaba de mostrar en un listado (familia o variaciones).
 * Permite resolver referencias posicionales («el primero», «la segunda») sin volver
 * a interpretar el catálogo.
 */
export interface OfferedOption {
  productId: number;
  name: string;
  /** Ausente en productos variables: en WooCommerce el SKU vive en cada variación. */
  sku?: string;
  /** El cliente aún debe elegir una variación antes de poder agregarlo. */
  variable?: boolean;
}

export interface SalesContext {
  phase: SalesPhase;
  flowStep?: ConversationFlowStep;
  cartItems?: PendingCartItem[];
  customerName?: string;
  /** Último listado mostrado, para resolver «el primero» o «la última». */
  lastOptions?: OfferedOption[];
  /** SKUs agregados en el turno anterior, para «solo los que te dije». */
  lastAddedSkus?: string[];
  /** Link de checkout ya enviado; el carrito de WhatsApp se vacía al generarlo. */
  lastCheckoutUrl?: string;
  lastOrderId?: string;
  /** Pedido WooCommerce MASSI creado vía massi-bot-api */
  massiWooOrderId?: number;
  massiWooOrderNumber?: string;
  massiTicketCode?: string;
  paymentMethod?: string;
}

export interface ChatSession {
  tenantId: string;
  customerPhone: string;
  messages: ChatMessage[];
  salesContext?: SalesContext;
  updatedAt: string;
}

export interface IChatSessionRepository {
  find(tenantId: string, customerPhone: string): Promise<ChatSession | null>;
  save(session: ChatSession): Promise<void>;
}
