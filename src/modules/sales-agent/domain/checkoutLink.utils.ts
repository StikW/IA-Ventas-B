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

export interface CheckoutLinkItem {
  sku: string;
  qty: number;
  packUnits?: number;
}

/**
 * Paquetes: `SKUx10:1` (WhatsApp-safe). El plugin también acepta `~` y `--`
 * porque WhatsApp convierte `~` en tachado y el link llega como `SKU--10:1`.
 */
export function encodeCheckoutItems(items: PendingCartItem[]): string {
  const parts: string[] = [];

  for (const item of items) {
    const sku = item.sku?.trim();
    if (!sku) continue;

    if (item.packUnits && item.packUnits > 0) {
      parts.push(`${sku}x${item.packUnits}:${item.quantity}`);
      continue;
    }

    parts.push(`${sku}:${item.quantity}`);
  }

  return parts.join(',');
}

export function parseCheckoutItems(raw: string): CheckoutLinkItem[] {
  const normalized = normalizeCheckoutItemsRaw(raw);
  if (!normalized) return [];

  const items: CheckoutLinkItem[] = [];
  for (const chunk of normalized.split(',')) {
    const part = decodeCheckoutItemPart(chunk);
    if (!part) continue;

    const pack = parseCheckoutPackPart(part);
    if (pack) {
      items.push(pack);
      continue;
    }

    const simple = part.match(/^(.+):(\d+)$/);
    if (!simple) continue;

    const sku = simple[1].trim();
    const qty = clampCheckoutQty(Number.parseInt(simple[2], 10));
    if (!sku) continue;

    const existing = items.find((row) => row.sku === sku && !row.packUnits);
    if (existing) {
      existing.qty = clampCheckoutQty(existing.qty + qty);
      continue;
    }
    items.push({ sku, qty });
  }

  return items;
}

export function normalizeCheckoutItemsRaw(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.includes('.') && !trimmed.includes(',')) {
    return trimmed.replace(/\./g, ',');
  }
  return trimmed;
}

function decodeCheckoutItemPart(part: string): string {
  const trimmed = part.trim();
  if (!trimmed) return '';
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function parseCheckoutPackPart(part: string): CheckoutLinkItem | null {
  const patterns = [
    /^(.+)~(\d+):(\d+)$/,
    /^(.+?)x(\d+):(\d+)$/i,
    /^(.+?)--+(\d+):(\d+)$/,
  ];

  for (const pattern of patterns) {
    const matches = part.match(pattern);
    if (!matches) continue;

    const sku = matches[1].replace(/[-~]+$/g, '').trim();
    const packUnits = clampCheckoutQty(Number.parseInt(matches[2], 10));
    const qty = clampCheckoutQty(Number.parseInt(matches[3], 10));
    if (!sku) continue;
    return { sku, qty, packUnits };
  }

  return null;
}

function clampCheckoutQty(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(200, Math.trunc(value)));
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
