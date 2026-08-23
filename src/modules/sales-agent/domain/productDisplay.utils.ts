import { MassiBotVariation } from '../../massi-bot/domain/IMassiBotService';
import { WooCommerceProduct } from '../../woocommerce/domain/IWooCommerceService';
import { OfferedOption } from './IChatSessionRepository';
import { EMOJI, warmOptionsOpener } from './tone.utils';

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

/**
 * Los listados van numerados porque el cliente responde con la posición («el primero»)
 * mucho más a menudo que con el ID.
 */
function bullet(position?: number): string {
  return position ? `${position}.` : '·';
}

export function formatVariationLineForUser(variation: MassiBotVariation, position?: number): string {
  const label = variationDisplayLabel(variation);
  const price = formatDisplayPrice(variation.price);
  const productId = variation.sku?.trim() || '—';
  const stockNote = variation.stockStatus !== 'instock' ? ' _(agotado)_' : '';
  return `${bullet(position)} ${label} — $${price}${stockNote} — ${PRODUCT_ID_LABEL}: *${productId}*`;
}

export function formatSimpleProductLineForUser(
  product: WooCommerceProduct,
  position?: number
): string {
  const price = formatDisplayPrice(product.price);
  const productId = product.sku?.trim() || '—';
  const stockNote = product.stockStatus !== 'instock' ? ' _(agotado)_' : '';
  return `${bullet(position)} ${product.name.trim()} — $${price}${stockNote} — ${PRODUCT_ID_LABEL}: *${productId}*`;
}

/** Máximo de productos que se listan en un mensaje de WhatsApp. */
export const PRODUCT_LIST_MAX_LINES = 8;

/**
 * Línea de producto dentro de un listado de familia. Los productos variables no tienen SKU
 * propio en WooCommerce (el SKU vive en cada variación), así que se ofrece verlas.
 */
export function formatFamilyProductLineForUser(
  product: WooCommerceProduct,
  position?: number
): string {
  const price = formatDisplayPrice(product.price);
  const stockNote = product.stockStatus !== 'instock' ? ' _(agotado)_' : '';
  const name = product.name.replace(/^[:\s-]+/, '').trim();
  const sku = product.sku?.trim();

  return sku
    ? `${bullet(position)} ${name} — $${price}${stockNote} — ${PRODUCT_ID_LABEL}: *${sku}*`
    : `${bullet(position)} ${name} — desde $${price}${stockNote} — _varias opciones (dime ${position ?? 'el número'} para verlas)_`;
}

/** Opción de un listado, para resolver después «el primero» sin volver a buscar. */
export function toOfferedOptionFromProduct(product: WooCommerceProduct): OfferedOption {
  const sku = product.sku?.trim();
  return {
    productId: product.id,
    name: product.name.trim(),
    sku: sku || undefined,
    variable: product.type === 'variable' && !sku,
  };
}

export function toOfferedOptionFromVariation(
  variation: MassiBotVariation,
  parentName: string
): OfferedOption {
  return {
    productId: variation.parentId || variation.id,
    name: `${parentName} - ${variationDisplayLabel(variation)}`.trim(),
    sku: variation.sku?.trim() || undefined,
  };
}

export function buildFamilyProductListMessage(
  familyTerm: string,
  products: WooCommerceProduct[],
  totalCount: number
): string {
  const lines = products.map((product, index) =>
    formatFamilyProductLineForUser(product, index + 1)
  );

  const intro =
    totalCount > lines.length
      ? `${warmOptionsOpener(familyTerm)} Tenemos ${totalCount} opciones de *${familyTerm}* ${EMOJI.gem} Te muestro algunas:`
      : `${warmOptionsOpener(familyTerm)} Estas son nuestras opciones de *${familyTerm}* ${EMOJI.gem}`;

  const closing =
    totalCount > lines.length
      ? `Dime el *número* o el *${PRODUCT_ID_LABEL}* del que te guste. Si sale _varias opciones_, el número abre las tallas y colores ${EMOJI.search}`
      : `Dime el *número* o el *${PRODUCT_ID_LABEL}* del que te guste y lo preparo ${EMOJI.sparkle}`;

  return [intro, '', ...lines, '', closing].join('\n');
}

/** Varias coincidencias con puntaje parecido: el agente pregunta en vez de adivinar. */
export function buildAmbiguousProductMessage(products: WooCommerceProduct[]): string {
  const lines = products.map((product, index) =>
    formatFamilyProductLineForUser(product, index + 1)
  );

  return [
    `Tengo varias que encajan con lo que me pides ${EMOJI.gem} ¿Cuál te muestro?`,
    '',
    ...lines,
    '',
    `Responde con el número o el *${PRODUCT_ID_LABEL}* y seguimos ${EMOJI.smile}`,
  ].join('\n');
}

export function buildProductFamilyVariantsMessage(
  parentName: string,
  lines: string[],
  filteredByVariant?: string
): string {
  const intro = filteredByVariant
    ? `Estas son las opciones de *${parentName}* que coinciden con *${filteredByVariant}* ${EMOJI.gem}`
    : `${warmOptionsOpener(parentName)} Estas son las opciones de *${parentName}* ${EMOJI.gem}`;

  return [
    intro,
    '',
    ...lines,
    '',
    `Dime el número o el *${PRODUCT_ID_LABEL}* de la que quieras y la agrego a tu pedido ${EMOJI.cart}`,
  ].join('\n');
}
