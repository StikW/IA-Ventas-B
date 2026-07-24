import { PendingCartItem } from './IChatSessionRepository';

/** Parámetros estándar para el formulario MASSI/WC (plugin puede leerlos). */
export const CHECKOUT_QUERY = {
  phone: 'phone',
  source: 'source',
  items: 'items',
} as const;

export interface BuildCheckoutLinkInput {
  /** URL base del formulario (absoluta). Si no se define, se usa `{storeUrl}/checkout/`. */
  checkoutFormUrl?: string;
  storeUrl: string;
  customerPhone: string;
  cartItems: PendingCartItem[];
}

export interface BuildCheckoutLinkResult {
  ok: boolean;
  url?: string;
  message?: string;
}

/** Codifica ítems como `SKU:cantidad,SKU:cantidad` */
export function encodeCheckoutItems(items: PendingCartItem[]): string {
  return items
    .filter((item) => item.sku?.trim())
    .map((item) => `${encodeURIComponent(item.sku.trim())}:${item.quantity}`)
    .join(',');
}

/**
 * Construye URL al formulario de compra WooCommerce/MASSI.
 * El plugin WP puede leer `phone`, `source=whatsapp` e `items`.
 */
export function buildCheckoutFormUrl(input: BuildCheckoutLinkInput): BuildCheckoutLinkResult {
  const storeUrl = input.storeUrl.replace(/\/$/, '');
  if (!storeUrl) {
    return { ok: false, message: 'No hay URL de tienda configurada.' };
  }

  const items = input.cartItems.filter((item) => item.sku?.trim());
  if (!items.length) {
    return { ok: false, message: 'El carrito no tiene productos con SKU.' };
  }

  const base =
    input.checkoutFormUrl?.trim() ||
    `${storeUrl}/checkout/`;

  let url: URL;
  try {
    url = new URL(base.startsWith('http') ? base : `${storeUrl}/${base.replace(/^\//, '')}`);
  } catch {
    return { ok: false, message: 'URL del formulario de compra inválida.' };
  }

  const phone = input.customerPhone.replace(/\D/g, '');
  url.searchParams.set(CHECKOUT_QUERY.phone, phone);
  url.searchParams.set(CHECKOUT_QUERY.source, 'whatsapp');
  url.searchParams.set(CHECKOUT_QUERY.items, encodeCheckoutItems(items));

  return { ok: true, url: url.toString() };
}
