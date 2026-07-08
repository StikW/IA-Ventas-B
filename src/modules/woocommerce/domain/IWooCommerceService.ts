export interface WooCommerceConfigData {
  tenantId: string;
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  connected: boolean;
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
}

export interface WooCommerceOrderPayload {
  paymentMethod: string;
  paymentMethodTitle: string;
  setPaid: boolean;
  billing: { firstName: string; phone: string; email?: string };
  lineItems: Array<{ productId: number; quantity: number }>;
}

export interface WooCommerceOrderResult {
  id: number;
  number: string;
  status: string;
  total: string;
}

export interface IWooCommerceService {
  testConnection(config: WooCommerceConfigData): Promise<boolean>;
  listProducts(config: WooCommerceConfigData, page?: number): Promise<WooCommerceProduct[]>;
  getProductBySku(config: WooCommerceConfigData, sku: string): Promise<WooCommerceProduct | null>;
  createOrder(config: WooCommerceConfigData, order: WooCommerceOrderPayload): Promise<WooCommerceOrderResult>;
}

export interface IWooCommerceConfigRepository {
  findByTenantId(tenantId: string): Promise<WooCommerceConfigData | null>;
  save(config: WooCommerceConfigData): Promise<void>;
  delete(tenantId: string): Promise<void>;
}
