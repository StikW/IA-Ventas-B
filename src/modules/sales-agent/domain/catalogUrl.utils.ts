/** URL base de la tienda WooCommerce. */
export function resolveStoreBaseUrl(storeUrl: string | undefined | null): string | null {
  const trimmed = storeUrl?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function joinStorePath(base: string, path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalized}`.replace(/([^:]\/)\/+/g, '$1');
}

/**
 * URL pública del catálogo (página de productos WC).
 * Prioridad: shopPagePath detectado (ej. `/tienda/`) → `/shop/` → raíz tienda.
 */
export function resolveStoreCatalogUrl(
  storeUrl: string | undefined | null,
  shopPagePath?: string | null
): string | null {
  const base = resolveStoreBaseUrl(storeUrl);
  if (!base) return null;

  const path = shopPagePath?.trim();
  if (path) return joinStorePath(base, path);

  return joinStorePath(base, '/shop/');
}

export const CATALOG_CTA_LABEL = 'Ver catálogo';
