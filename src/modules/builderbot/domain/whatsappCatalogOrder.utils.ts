/**
 * Pedido del catálogo nativo de WhatsApp (Meta) que BBC reenvía en EVENTS.ORDER
 * como `order` / `{orderData}`.
 */

export interface WhatsAppCatalogOrderProduct {
  retailerId: string;
  quantity: number;
  name?: string;
  price?: number;
  currency?: string;
}

export interface ParsedWhatsAppCatalogOrder {
  from: string;
  phone: string;
  name?: string;
  products: WhatsAppCatalogOrderProduct[];
  catalogId?: string;
  totalAmount?: number;
  currency?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function coercePositiveInt(value: unknown, fallback = 1): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function parseOrderObject(order: Record<string, unknown>): {
  products: WhatsAppCatalogOrderProduct[];
  catalogId?: string;
  totalAmount?: number;
  currency?: string;
} {
  const products: WhatsAppCatalogOrderProduct[] = [];

  for (const entry of asArray(order.products)) {
    const product = asRecord(entry);
    if (!product) continue;
    const retailerId = String(product.retailerId ?? product.product_retailer_id ?? '').trim();
    if (!retailerId) continue;
    products.push({
      retailerId,
      quantity: coercePositiveInt(product.quantity, 1),
      name: product.name != null ? String(product.name) : undefined,
      price: typeof product.price === 'number' ? product.price : undefined,
      currency: product.currency != null ? String(product.currency) : undefined,
    });
  }

  if (!products.length) {
    const raw = asRecord(order.raw);
    for (const entry of asArray(raw?.product_items)) {
      const item = asRecord(entry);
      if (!item) continue;
      const retailerId = String(item.product_retailer_id ?? item.retailerId ?? '').trim();
      if (!retailerId) continue;
      products.push({
        retailerId,
        quantity: coercePositiveInt(item.quantity, 1),
        price: typeof item.item_price === 'number' ? item.item_price : undefined,
        currency: item.currency != null ? String(item.currency) : undefined,
      });
    }
  }

  const catalogId = order.catalogId ?? order.catalog_id;
  const totalAmount = order.totalAmount ?? order.total_amount;

  return {
    products,
    catalogId: catalogId != null ? String(catalogId) : undefined,
    totalAmount: typeof totalAmount === 'number' ? totalAmount : undefined,
    currency: order.currency != null ? String(order.currency) : undefined,
  };
}

function resolveOrderRecord(payload: Record<string, unknown>): Record<string, unknown> | null {
  const direct = payload.order ?? payload.orderData;
  if (typeof direct === 'string') {
    const trimmed = direct.trim();
    if (!trimmed || trimmed.startsWith('{') === false) return null;
    try {
      return asRecord(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return asRecord(direct);
}

/** Texto centinela que BBC manda en `{body}` para pedidos del catálogo Meta. */
export function isWhatsAppCatalogOrderEventText(text: string | undefined): boolean {
  return !!text && /^_event_order__/i.test(text.trim());
}

export function parseWhatsAppCatalogOrder(payload: unknown): ParsedWhatsAppCatalogOrder | null {
  const root = asRecord(payload);
  if (!root) return null;

  const from = String(root.from ?? root.phone ?? '').trim();
  const phone = String(root.phone ?? root.from ?? '').trim();
  if (!from && !phone) return null;

  const order = resolveOrderRecord(root);
  if (!order) return null;

  const parsed = parseOrderObject(order);
  if (!parsed.products.length) return null;

  return {
    from: from || phone,
    phone: phone || from,
    name: root.name != null ? String(root.name) : undefined,
    products: parsed.products,
    catalogId: parsed.catalogId,
    totalAmount: parsed.totalAmount,
    currency: parsed.currency,
  };
}
