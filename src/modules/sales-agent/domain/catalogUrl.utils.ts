/** URL pública del catálogo WooCommerce (página de la tienda). */
export function resolveStoreCatalogUrl(storeUrl: string | undefined | null): string | null {
  const trimmed = storeUrl?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export const CATALOG_CTA_LABEL = 'Ver catálogo';
