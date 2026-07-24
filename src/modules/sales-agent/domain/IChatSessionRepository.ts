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

export interface SalesContext {
  phase: SalesPhase;
  flowStep?: ConversationFlowStep;
  cartItems?: PendingCartItem[];
  customerName?: string;
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
