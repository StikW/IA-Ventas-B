import { normalizeProductText, stripWhatsAppFormatting } from './productSelection.utils';

const SEND_NOW =
  /\b(?:m[aá]nd(?:ame|ame|amele|a)|pasa(?:me)?|env[ií]a(?:me)?|comparte(?:me)?)\b.{0,24}\b(?:link|enlace|fotos?|im[aá]genes?|p[aá]gina|ficha|url)\b/i;

const BARE_LINK = /^(?:el\s+)?(?:link|enlace)(?:\s+por\s+fa(?:vor)?)?\.?$/i;

const INFO_ASK =
  /\b(?:m[aá]s\s+(?:info(?:rmaci[oó]n)?|detalles?|datos)|saber\s+m[aá]s|conocer\s+m[aá]s|c[oó]mo\s+se\s+ve|c[oó]mo\s+es|ver(?:lo|la)?\s+(?:mejor|bien|en\s+(?:la\s+)?(?:p[aá]gina|tienda|web))|ver\s+(?:fotos?|im[aá]genes?|la\s+ficha|el\s+link|el\s+enlace)|fotos?|im[aá]genes?|el\s+link|el\s+enlace|la\s+p[aá]gina|la\s+ficha)\b/i;

/**
 * "info" a secas también aparece en preguntas generales ("me das información?"), así que
 * solo cuenta cuando el cliente señala qué producto quiere ver o el mensaje es solo eso.
 */
const INFO_WITH_REFERENCE =
  /^info(?:rmaci[oó]n)?\.?$|\binfo(?:rmaci[oó]n)?\b(?:\s+(?:de|del|sobre|la|el|la\s+opci[oó]n))?\s+(?:#?\d{1,2}\b|[a-z]\b|[A-Za-z]{2,}[A-Za-z0-9._-]*\d)/i;

/** Pide ver la ficha / fotos de un producto que ya está en contexto. */
export function isProductPageInfoIntent(text: string): boolean {
  const clean = stripWhatsAppFormatting(text).trim();
  const t = normalizeProductText(clean);
  if (!t) return false;
  if (/\b(?:finalizar|checkout|formulario|completar\s+(?:la\s+)?compra)\b/.test(t)) return false;
  return (
    SEND_NOW.test(clean) ||
    INFO_ASK.test(clean) ||
    INFO_WITH_REFERENCE.test(clean) ||
    BARE_LINK.test(clean)
  );
}

/** Ya pidió el enlace o las fotos: no hace falta un segundo «¿te lo mando?». */
export function isProductPageSendNowIntent(text: string): boolean {
  const clean = stripWhatsAppFormatting(text).trim();
  return SEND_NOW.test(clean) || BARE_LINK.test(clean);
}

/**
 * Deja solo la referencia al producto: "info B" → "B", "mándame fotos del 3" → "del 3".
 * Sin esto, "info B" llega entero al resolutor y no coincide con ninguna opción.
 */
export function stripProductPageWords(text: string): string {
  return stripWhatsAppFormatting(text)
    .replace(
      /\b(?:m[aá]nd(?:ame|amele|a)|pasa(?:me)?|env[ií]a(?:me)?|comparte(?:me)?|quiero|dame|ver|mostrar|mu[eé]strame|m[aá]s|info(?:rmaci[oó]n)?|detalles?|datos|fotos?|im[aá]genes?|ficha|link|enlace|url|p[aá]gina|porfa(?:vor)?|por\s+favor)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ProductPageCard {
  url: string;
  price?: string;
  description?: string;
}

/**
 * Pie de la foto del producto. Va también como texto suelto cuando el canal no acepta
 * media, así que tiene que sostenerse solo: nombre, precio y enlace a la ficha.
 */
export function formatProductPageLink(
  productName: string,
  urlOrCard: string | ProductPageCard
): string {
  const card = typeof urlOrCard === 'string' ? { url: urlOrCard } : urlOrCard;
  const price = formatProductPagePrice(card.price);
  const summary = summarizeDescription(card.description);

  return [
    `*${productName}*`,
    price ? `Precio: ${price}` : '',
    summary,
    '',
    `Fotos y detalle completo aquí:\n${card.url}`,
  ]
    .filter((line, index, lines) => line !== '' || lines[index + 1])
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function formatProductPagePrice(price?: string): string {
  const digits = (price ?? '').replace(/[^\d]/g, '');
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) && value > 0 ? `$${value.toLocaleString('es-CO')}` : '';
}

/** La descripción de WooCommerce viene en HTML y suele ser larga para WhatsApp. */
function summarizeDescription(description?: string, maxLength = 220): string {
  const text = (description ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';
  if (text.length <= maxLength) return text;

  const cut = text.slice(0, maxLength);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '));
  return `${(lastStop > 80 ? cut.slice(0, lastStop) : cut).trim()}…`;
}

export function formatProductPageNeedChoice(): string {
  return '¿De cuál te muestro las fotos? Dime su *letra* o su *ID* (por ejemplo *info B*).';
}

export function formatProductPageMissing(): string {
  return 'No pude abrir esa ficha. Dime otro *ID* o la *letra* de la lista.';
}
