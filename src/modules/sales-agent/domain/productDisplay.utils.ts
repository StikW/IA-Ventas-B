import { MassiBotVariation } from '../../massi-bot/domain/IMassiBotService';
import { WooCommerceProduct } from '../../woocommerce/domain/IWooCommerceService';
import { OfferedOption } from './IChatSessionRepository';
import { EMOJI, warmOptionsOpener } from './tone.utils';

/** Etiqueta visible para el cliente (internamente sigue siendo SKU). */
export const PRODUCT_ID_LABEL = 'ID';

/**
 * Acepta `unknown` a propósito: la API de WooCommerce promete cadena, pero los plugins de
 * precios devuelven números. Un listado entero no puede caerse por el tipo de un campo.
 */
export function formatDisplayPrice(price: unknown): string {
  const raw = typeof price === 'number' ? String(price) : typeof price === 'string' ? price : '';
  const digits = raw.replace(/[^\d]/g, '');
  const num = Number.parseInt(digits, 10);
  if (!Number.isFinite(num)) return raw.trim();
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
 * Los listados van etiquetados porque el cliente responde con la posición mucho más a
 * menudo que con el ID. Se usan letras y no números: media tienda se llama por su número
 * (*Balín #6*, anillos por talla), y «el 6» sería ambiguo para el cliente y para el agente.
 */
export function optionLabel(position: number): string {
  const index = position - 1;
  if (index < 0 || index >= 26) return String(position);
  return String.fromCharCode(65 + index);
}

function bullet(position?: number): string {
  return position ? `${optionLabel(position)})` : '·';
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
    : `${bullet(position)} ${name} — desde $${price}${stockNote} — _varias opciones (dime ${
        position ? optionLabel(position) : 'su letra'
      } para verlas)_`;
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

/**
 * Muchos clientes no saben que pueden pedir la ficha; si no se les ofrece, eligen a ciegas
 * por el nombre. Se invita en cada listado, no solo cuando preguntan.
 */
export const PRODUCT_INFO_INVITE = `¿Quieres ver *fotos* y detalles de alguno? Dime *info* y su letra (ej. *info A*) ${EMOJI.search}`;

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
      ? `Dime la *letra* o el *${PRODUCT_ID_LABEL}* del que te guste. Si sale _varias opciones_, la letra abre las tallas y colores`
      : `Dime la *letra* o el *${PRODUCT_ID_LABEL}* del que te guste y lo preparo ${EMOJI.sparkle}`;

  return [intro, '', ...lines, '', closing, PRODUCT_INFO_INVITE].join('\n');
}

/** Varias líneas del último listado comparten el mismo #N; el cliente elige letra o ID. */
export function buildListedNumberChoiceMessage(
  productNumber: string,
  options: OfferedOption[]
): string {
  const lines = options.map((option, index) => {
    const sku = option.sku?.trim() || '—';
    return `${bullet(index + 1)} ${option.name.trim()} — ${PRODUCT_ID_LABEL}: *${sku}*`;
  });

  return [
    `Hay varias opciones de *#${productNumber}* en el listado ${EMOJI.gem} ¿Cuál quieres?`,
    '',
    ...lines,
    '',
    `Dime la *letra* o el *${PRODUCT_ID_LABEL}* del que te guste ${EMOJI.smile}`,
    PRODUCT_INFO_INVITE,
  ].join('\n');
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
    `Responde con la letra o el *${PRODUCT_ID_LABEL}* y seguimos ${EMOJI.smile}`,
    PRODUCT_INFO_INVITE,
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
    `Dime la letra o el *${PRODUCT_ID_LABEL}* de la que quieras y la agrego a tu pedido ${EMOJI.cart}`,
    PRODUCT_INFO_INVITE,
  ].join('\n');
}
