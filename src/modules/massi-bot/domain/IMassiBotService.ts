import { WooCommerceConfigData } from '../../woocommerce/domain/IWooCommerceService';

export interface MassiBotClientProfile {
  phone: string;
  found: boolean;
  profile: {
    firstName: string;
    lastName: string;
    email: string;
    document: string;
    city: string;
  } | null;
}

export interface MassiBotVariation {
  id: number;
  parentId: number;
  name: string;
  sku: string;
  price: string;
  stockStatus: string;
  stockQuantity: number | null;
  attributes: Array<{ name: string; value: string }>;
  isVariation?: boolean;
}

export interface MassiBotOrderSummary {
  id: number;
  number: string;
  status: string;
  total: string;
  currency: string;
  paymentMethod: string;
  operationalStatus: string;
  operationalLabel: string;
  ticketCode: string;
  paymentReportStatus: string;
  createdAt: string;
  items?: Array<{
    productId: number;
    variationId: number;
    name: string;
    quantity: number;
    total: string;
  }>;
  customerPhone?: string;
  customerName?: string;
  deliveryType?: string;
}

export interface MassiBotCreateOrderInput {
  phone: string;
  customerName: string;
  paymentMethod: string;
  deliveryType?: string;
  lineItems: Array<{
    productId: number;
    variationId?: number;
    quantity: number;
  }>;
  idempotencyKey?: string;
}

export interface MassiBotPaymentReportInput {
  orderId: number;
  phone: string;
  proofUrl: string;
  amount?: number;
  note?: string;
}

export interface MassiBotPaymentReportResult {
  orderId: number;
  paymentReportStatus: string;
  operationalStatus: string;
  operationalLabel: string;
  ticketCode: string;
}

export interface IMassiBotService {
  isConfigured(config: WooCommerceConfigData): boolean;
  ping(config: WooCommerceConfigData): Promise<boolean>;
  findClientByPhone(config: WooCommerceConfigData, phone: string): Promise<MassiBotClientProfile>;
  listOrdersByPhone(config: WooCommerceConfigData, phone: string, limit?: number): Promise<MassiBotOrderSummary[]>;
  getProductVariations(config: WooCommerceConfigData, productId: number): Promise<MassiBotVariation[]>;
  findProductBySku(config: WooCommerceConfigData, sku: string): Promise<MassiBotVariation | null>;
  createOrder(config: WooCommerceConfigData, input: MassiBotCreateOrderInput): Promise<MassiBotOrderSummary>;
  submitPaymentReport(config: WooCommerceConfigData, input: MassiBotPaymentReportInput): Promise<MassiBotPaymentReportResult>;
}
