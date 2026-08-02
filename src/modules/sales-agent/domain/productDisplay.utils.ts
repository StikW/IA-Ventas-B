import { MassiBotVariation } from '../../massi-bot/domain/IMassiBotService';
import { WooCommerceProduct } from '../../woocommerce/domain/IWooCommerceService';

/** Etiqueta visible para el cliente (internamente sigue siendo SKU). */
export const PRODUCT_ID_LABEL = 'ID';

export function formatDisplayPrice(price: string): string {
  const digits = price.replace(/[^\d]/g, '');
  const num = Number.parseInt(digits, 10);
  if (!Number.isFinite(num)) return price.trim();
  return num.toLocaleString('es-CO');
}

export function variationDisplayLabel(variation: MassiBotVariation): string {
  if (variation.attributes.length) {
    return variation.attributes.map((attr) => attr.value).join(' · ');
  }
  if (variation.name.includes(' - ')) {
    return variation.name.split(' - ').slice(1).join(' - ').trim();
  }
  return variation.name.trim();
}

export function formatVariationLineForUser(variation: MassiBotVariation): string {
  const label = variationDisplayLabel(variation);
  const price = formatDisplayPrice(variation.price);
  const productId = variation.sku?.trim() || '—';
  const stockNote = variation.stockStatus !== 'instock' ? ' _(agotado)_' : '';
  return `· ${label} — $${price}${stockNote} — ${PRODUCT_ID_LABEL}: *${productId}*`;
}

export function formatSimpleProductLineForUser(product: WooCommerceProduct): string {
  const price = formatDisplayPrice(product.price);
  const productId = product.sku?.trim() || '—';
  const stockNote = product.stockStatus !== 'instock' ? ' _(agotado)_' : '';
  return `· ${product.name.trim()} — $${price}${stockNote} — ${PRODUCT_ID_LABEL}: *${productId}*`;
}

export function buildProductFamilyVariantsMessage(
  parentName: string,
  lines: string[],
  filteredByVariant?: string
): string {
  const intro = filteredByVariant
    ? `Estas son las opciones de *${parentName}* que coinciden con *${filteredByVariant}*:`
    : `Estas son las opciones de *${parentName}*:`;

  return [
    intro,
    '',
    ...lines,
    '',
    `Envíame el *${PRODUCT_ID_LABEL}* de la que te interesa y la agrego a tu pedido.`,
  ].join('\n');
}
