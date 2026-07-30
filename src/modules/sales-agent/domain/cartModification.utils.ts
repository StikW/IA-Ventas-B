import {
  cartItemMatchesVariantHint,
  extractQuantityFromText,
  extractVariantHint,
  looksLikeSku,
  normalizeProductText,
  tokenizeProductQuery,
  VARIANT_STRIP_PATTERN,
} from './productSelection.utils';
import { PendingCartItem } from './IChatSessionRepository';

const WORD_QUANTITY: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};

/** Producto del carrito identificado por nombre, variante, SKU o texto libre del cliente. */
export interface CartTargetSpec {
  variantHint?: string;
  sku?: string;
  productTokens: string[];
  quantity: number;
  rawText: string;
}

const MIN_CART_MATCH_SCORE = 25;

export function extractSpokenQuantity(text: string, defaultQty = 1): number {
  const fromDigits = extractQuantityFromText(text, 0);
  if (fromDigits > 0) return fromDigits;

  const t = normalizeProductText(text);
  for (const [word, qty] of Object.entries(WORD_QUANTITY)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return qty;
  }

  if (/\b(las|los)\s+dos\b/.test(t)) return 2;
  if (/\b(las|los)\s+tres\b/.test(t)) return 3;

  return defaultQty;
}

function tokenMatchesProductBlob(token: string, blob: string): boolean {
  if (blob.includes(token)) return true;
  if (token.length > 3 && token.endsWith('s') && blob.includes(token.slice(0, -1))) return true;
  if (token.length > 3 && blob.includes(`${token}s`)) return true;
  return false;
}

function stripCartTargetNoise(text: string): string {
  return text
    .replace(/^(?:por favor\s+)?(?:me\s+)?(?:quiero\s+)?(?:eliminar|quitar|sacar|remover|borrar)\s+/i, '')
    .replace(/^no\s+quiero\s+/i, '')
    .replace(/^(?:deja(?:r)?\s+(?:solo|solamente)|pon(?:er)?|baja(?:r)?\s+a|cambia(?:r)?\s+a)\s+/i, '')
    .replace(/^(?:las?|los?|el|la|del|de la|de)\s+/i, '')
    .trim();
}

/** Extrae qué producto del carrito describe el cliente (cualquier catálogo). */
export function extractCartTarget(text: string, defaultQty = 1): CartTargetSpec {
  const rawText = text.trim();
  let cleaned = stripCartTargetNoise(rawText);

  let sku: string | undefined;
  if (looksLikeSku(cleaned)) {
    sku = cleaned;
    cleaned = '';
  } else {
    const skuMatch = cleaned.match(/\b([A-Za-z0-9][A-Za-z0-9._-]{3,})\b/);
    if (skuMatch && looksLikeSku(skuMatch[1]!)) {
      sku = skuMatch[1];
      cleaned = cleaned.replace(skuMatch[0], ' ').trim();
    }
  }

  const variantHint = extractVariantHint(cleaned || rawText);
  const productQuery = (cleaned || rawText)
    .replace(VARIANT_STRIP_PATTERN, '')
    .replace(
      /\b(?:las?|los?|del|de la|de|una?|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|piezas?|unidades?|pares?)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();

  const productTokens = tokenizeProductQuery(productQuery);

  return {
    variantHint,
    sku,
    productTokens,
    quantity: extractSpokenQuantity(rawText, defaultQty),
    rawText,
  };
}

export function buildProductQueryFromTarget(target: CartTargetSpec): string {
  if (target.sku) return target.sku;
  const parts = [...target.productTokens];
  if (target.variantHint) parts.push(target.variantHint);
  if (parts.length) return parts.join(' ');
  return target.rawText;
}

export function scoreCartItemMatch(item: PendingCartItem, target: CartTargetSpec): number {
  if (target.sku && item.sku.toLowerCase() === target.sku.toLowerCase()) return 100;

  const blob = normalizeProductText(`${item.name} ${item.sku}`);
  let score = 0;

  if (target.variantHint) {
    if (!cartItemMatchesVariantHint(item, target.variantHint)) return 0;
    score += 50;
  }

  if (target.productTokens.length) {
    const matched = target.productTokens.filter((token) => tokenMatchesProductBlob(token, blob));
    if (!matched.length) return target.variantHint ? score : 0;
    score += matched.length * 15;
    if (matched.length === target.productTokens.length) score += 20;
  }

  return score;
}

export function findCartMatches(items: PendingCartItem[], target: CartTargetSpec): PendingCartItem[] {
  return items
    .map((item) => ({ item, score: scoreCartItemMatch(item, target) }))
    .filter((row) => row.score >= MIN_CART_MATCH_SCORE)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);
}

export function findBestCartMatch(items: PendingCartItem[], target: CartTargetSpec): PendingCartItem | undefined {
  return findCartMatches(items, target)[0];
}

export function isCartClearIntent(text: string): boolean {
  const t = normalizeProductText(text);

  if (/(?:vaciar|limpiar|borrar|eliminar|quitar|cancelar)\s+(?:el\s+|mi\s+|tu\s+)?carrito/.test(t)) {
    return true;
  }

  if (/(?:quiero|quisiera|me gustaria|deseo)\s+(?:eliminar|vaciar|borrar|limpiar|quitar)\s+(?:el\s+|mi\s+)?carrito/.test(t)) {
    return true;
  }

  if (/cancelar\s+(?:el\s+)?(?:pedido|compra)/.test(t)) return true;
  if (/empezar\s+(?:de\s+)?cero/.test(t)) return true;
  if (/(?:eliminar|borrar)\s+todo/.test(t)) return true;

  return false;
}

export function isCartCorrectionIntent(text: string): boolean {
  const t = normalizeProductText(text);
  return (
    /no\s+quiero/.test(t) &&
    /(?:solo|solamente|nom[aá]s|nada\s+m[aá]s|unicamente|\bquiero\s+(?:solo|una?|un\b))/.test(t)
  );
}

export function isCartSetQuantityIntent(text: string): boolean {
  if (isCartCorrectionIntent(text) || isCartClearIntent(text)) return false;
  const t = normalizeProductText(text);
  return /deja(?:r)?\s+(?:solo|solamente)|pon(?:er)?\s+\d+|baja(?:r)?\s+a\s+\d+|cambia(?:r)?\s+(?:a\s+)?\d+/.test(
    t
  );
}

export function isCartRemoveIntent(text: string): boolean {
  if (isCartClearIntent(text) || isCartCorrectionIntent(text) || isCartSetQuantityIntent(text)) return false;
  const t = normalizeProductText(text);
  return /eliminar|quitar|sacar|remover|borrar/.test(t);
}

export interface CartCorrectionParts {
  remove: CartTargetSpec;
  want: CartTargetSpec;
}

export function parseCartCorrection(text: string): CartCorrectionParts | null {
  if (!isCartCorrectionIntent(text)) return null;

  const t = normalizeProductText(text);
  const match = t.match(
    /no\s+quiero\s+(.+?)(?:,\s*)?(?:quiero\s+)?(?:solo|solamente|nom[aá]s|nada\s+m[aá]s|unicamente)\s+(.+)/
  );
  if (!match) return null;

  return {
    remove: extractCartTarget(match[1]!.trim(), 99),
    want: extractCartTarget(match[2]!.trim(), 1),
  };
}

export interface CartRemoveRequest {
  target: CartTargetSpec;
  removeAll: boolean;
}

export function parseCartRemove(text: string): CartRemoveRequest {
  const t = normalizeProductText(text);
  const removeAll = /todas?|todo|completo/.test(t);
  const target = extractCartTarget(text, removeAll ? 99 : 1);

  return { target, removeAll };
}

export function parseCartSetQuantity(text: string): { target: CartTargetSpec; quantity: number } | null {
  if (!isCartSetQuantityIntent(text)) return null;

  const qtyFromDigits = extractQuantityFromText(text, 0);
  const quantity = qtyFromDigits > 0 ? qtyFromDigits : extractSpokenQuantity(text, 1);
  const target = extractCartTarget(text, quantity);

  return { target, quantity };
}

export function describeCartTarget(target: CartTargetSpec): string {
  if (target.sku) return target.sku;
  const parts = [...target.productTokens];
  if (target.variantHint) parts.push(target.variantHint);
  return parts.join(' ') || target.rawText;
}
