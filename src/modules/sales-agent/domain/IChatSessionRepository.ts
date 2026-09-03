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
  /** Unidades que cubre cada paquete (x10 / x5 / x2 / x1). */
  packUnits?: number;
  /** Total de unidades pedidas que originó esta línea de paquete. */
  packDesiredUnits?: number;
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

/** Producto del que el cliente está hablando (elegido por número, ID o el último cotizado). */
export interface FocusedProduct {
  productId: number;
  name: string;
  sku?: string;
}

/** Producto con paquetes woo-massi identificado, esperando la cantidad N. */
export interface PendingPackProduct {
  productId: number;
  sku: string;
  name: string;
  unitLabel: string;
  unitPlural: string;
}

/** Cotización de paquetes mostrada; no entra al carrito hasta que el cliente confirme. */
export interface PendingPackQuote {
  productId: number;
  sku: string;
  productName: string;
  unitLabel: string;
  unitPlural: string;
  desiredUnits: number;
  tiers: Array<{ units: number; price: number }>;
}

export interface SalesContext {
  phase: SalesPhase;
  flowStep?: ConversationFlowStep;
  cartItems?: PendingCartItem[];
  customerName?: string;
  /** Producto a granel identificado; el agente pidió cuántas unidades. */
  pendingPackProduct?: PendingPackProduct;
  /** Combinación de paquetes ofrecida, a la espera de «sí» / otra cantidad. */
  pendingPackQuote?: PendingPackQuote;
  /** Último listado mostrado, para resolver «el primero» o «la última». */
  lastOptions?: OfferedOption[];
  /** SKUs agregados en el turno anterior, para «solo los que te dije». */
  lastAddedSkus?: string[];
  /** Producto que el cliente acaba de elegir o del que está hablando. */
  focusedProduct?: FocusedProduct;
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
