export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  at: string;
}

export type SalesPhase = 'browsing' | 'awaiting_payment' | 'order_created';

export interface PendingCartItem {
  productId: number;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface SalesContext {
  phase: SalesPhase;
  cartItems?: PendingCartItem[];
  customerName?: string;
  lastOrderId?: string;
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
