import { PendingCartItem } from './IChatSessionRepository';

/** Parámetros estándar para el formulario MASSI/WC (plugin puede leerlos). */
export const CHECKOUT_QUERY = {
  phone: 'phone',
  source: 'source',
  items: 'items',
  /** Base pública de la tienda (ngrok/prod) para reescribir assets WP en dev */
  publicStore: 'public_store',
} as const;

export interface BuildCheckoutLinkInput {
  /** URL base del formulario (absoluta). Tiene prioridad sobre checkoutPagePath. */
  checkoutFormUrl?: string;
  /** Ruta checkout WC detectada, ej. `/finalizar-compra/`. Fallback antes de `/checkout/`. */
  checkoutPagePath?: string;
  storeUrl: string;
  customerPhone: string;
  cartItems: PendingCartItem[];
}

function joinStorePath(storeUrl: string, path: string): string {
  const base = storeUrl.replace(/\/$/, '');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalized.endsWith('/') ? normalized : `${normalized}/`}`;
}

export interface BuildCheckoutLinkResult {
  ok: boolean;
  url?: string;
  message?: string;
}

/** Codifica ítems para el link de checkout MASSI. */
export function encodeCheckoutItems(items: PendingCartItem[]): string {
  const parts: string[] = [];

  for (const item of items) {
    const sku = item.sku?.trim();
    if (!sku) continue;

    // Paquetes woo-massi: SKU~unidadesPorPaquete:cantidadDePaquetes (no unidades totales).
    // Ej.: 3× paquete x10 + 2× paquete x2 → BLD6AM006~10:3,BLD6AM006~2:2
    if (item.packUnits && item.packUnits > 0) {
      parts.push(`${encodeURIComponent(sku)}~${item.packUnits}:${item.quantity}`);
      continue;
    }

    parts.push(`${encodeURIComponent(sku)}:${item.quantity}`);
  }

  return parts.join(',');
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
    (input.checkoutPagePath?.trim()
      ? joinStorePath(storeUrl, input.checkoutPagePath.trim())
      : `${storeUrl}/checkout/`);

  let url: URL;
  try {
    url = new URL(base.startsWith('http') ? base : `${storeUrl}/${base.replace(/^\//, '')}`);
  } catch {
    return { ok: false, message: 'URL del formulario de compra inválida.' };
  }

  const phone = input.customerPhone.replace(/\D/g, '');
  url.searchParams.set(CHECKOUT_QUERY.phone, phone);
  url.searchParams.set(CHECKOUT_QUERY.source, 'whatsapp');
  url.searchParams.set(CHECKOUT_QUERY.publicStore, storeUrl);
  url.searchParams.set(CHECKOUT_QUERY.items, encodeCheckoutItems(items));

  return { ok: true, url: url.toString() };
}
