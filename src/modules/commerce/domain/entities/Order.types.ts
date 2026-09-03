export enum OrderStatus {
  PENDING = 'PENDING',
  AWAITING_PAYMENT = 'AWAITING_PAYMENT',
  PAID = 'PAID',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
}

export interface OrderItem {
  productId: number;
  variationId?: number;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  /** Unidades que cubre cada paquete (x10 / x5 / x2 / x1) en productos `woo-massi`. */
  packUnits?: number;
  /** Total de unidades pedidas que originó esta línea de paquete. */
  packDesiredUnits?: number;
}

export interface OrderProps {
  tenantId: string;
  customerPhone: string;
  customerName: string;
  items: OrderItem[];
  total: number;
  currency: string;
  status: OrderStatus;
  woocommerceOrderId?: string;
  woocommerceOrderNumber?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}
