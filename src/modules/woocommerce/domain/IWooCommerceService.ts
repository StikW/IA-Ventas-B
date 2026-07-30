export interface WooCommerceConfigData {
  tenantId: string;
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** Usuario WP con Application Password para massi-bot/v1 */
  botApiUser?: string;
  botApiPassword?: string;
  /** Ruta checkout WC detectada al probar conexión, ej. `/finalizar-compra/` */
  checkoutPagePath?: string;
  /** Ruta tienda/catálogo WC detectada al probar conexión, ej. `/tienda/` */
  shopPagePath?: string;
  connected: boolean;
  botApiConnected?: boolean;
  lastSyncAt?: string;
  updatedAt: string;
}

export interface WooCommerceProduct {
  id: number;
  name: string;
  sku: string;
  price: string;
  stockQuantity: number | null;
  stockStatus: string;
  description: string;
  status: string;
  type?: string;
}

export interface WooCommerceOrderPayload {
  paymentMethod: string;
  paymentMethodTitle: string;
  setPaid: boolean;
  billing: { firstName: string; phone: string; email?: string };
  lineItems: Array<{ productId: number; quantity: number }>;
}

export interface WooCommerceOrderUpdatePayload {
  setPaid?: boolean;
  status?: string;
}

export interface WooCommerceOrderResult {
  id: number;
  number: string;
  status: string;
  total: string;
}

export interface IWooCommerceService {
  testConnection(config: WooCommerceConfigData): Promise<{ checkoutPagePath?: string; shopPagePath?: string }>;
  resolveCheckoutPagePath(config: WooCommerceConfigData): Promise<string | null>;
  resolveShopPagePath(config: WooCommerceConfigData): Promise<string | null>;
  listProducts(config: WooCommerceConfigData, page?: number): Promise<WooCommerceProduct[]>;
  searchProducts(config: WooCommerceConfigData, query: string): Promise<WooCommerceProduct[]>;
  getProductBySku(config: WooCommerceConfigData, sku: string): Promise<WooCommerceProduct | null>;
  getProductById(config: WooCommerceConfigData, productId: number): Promise<WooCommerceProduct | null>;
  createOrder(config: WooCommerceConfigData, order: WooCommerceOrderPayload): Promise<WooCommerceOrderResult>;
  updateOrder(config: WooCommerceConfigData, orderId: number, update: WooCommerceOrderUpdatePayload): Promise<WooCommerceOrderResult>;
}

export interface IWooCommerceConfigRepository {
  findByTenantId(tenantId: string): Promise<WooCommerceConfigData | null>;
  save(config: WooCommerceConfigData): Promise<void>;
  delete(tenantId: string): Promise<void>;
}
