export enum OrderStatus {
  PENDING = 'PENDING',
  AWAITING_PAYMENT = 'AWAITING_PAYMENT',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
}

export interface OrderItem {
  productId: number;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
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
