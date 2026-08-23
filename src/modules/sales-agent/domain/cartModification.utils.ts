import {
  cartItemMatchesVariantHint,
  extractQuantityFromText,
  extractVariantHint,
  looksLikeExplicitSku,
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
  // Plural español en -es: "balines" → "balín", "collares" → "collar".
  if (token.length > 4 && token.endsWith('es') && blob.includes(token.slice(0, -2))) return true;
  if (token.length > 2 && blob.includes(`${token}es`)) return true;
  return false;
}

function stripCartTargetNoise(text: string): string {
  return text
    .replace(/^(?:por favor\s+)?(?:me\s+)?(?:quiero\s+)?(?:eliminar|quitar|sacar|remover|borrar)\s+/i, '')
    .replace(/^(?:ya\s+)?no\s+(?:lo\s+|la\s+|los\s+|las\s+)?quiero\s+/i, '')
    .replace(/^(?:otra|otro)\s+(?:unidad|pieza|m[aá]s)\s+(?:de|del|de\s+la|de\s+el)?\s*/i, '')
    .replace(/^(?:una?\s+m[aá]s)\s+(?:de|del|de\s+la)?\s*/i, '')
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
    // Dentro de una frase solo valen códigos inequívocos: "unidades" o "quiero" pasan
    // `looksLikeSku`, y una medida suelta ("45cm") describe la variante, no el SKU.
    const skuMatch = cleaned.match(/\b([A-Za-z0-9][A-Za-z0-9._-]{3,})\b/);
    if (skuMatch && looksLikeExplicitSku(skuMatch[1]!)) {
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

/** ¿El texto señala un producto? "no quiero 3" solo habla de cantidad, no de un ítem. */
export function hasProductReference(target: CartTargetSpec): boolean {
  return Boolean(target.sku || target.variantHint || target.productTokens.length);
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

/** "cómo va mi carrito", "qué hay en el carrito": solo quiere ver el resumen. */
export function isCartReviewIntent(text: string): boolean {
  const t = normalizeProductText(text);
  return (
    /(?:como|qu[eé])\s+(?:va|hay|tiene|tienes|est[aá])\s+(?:mi\s+|el\s+|en\s+(?:el\s+|mi\s+)?)?carrito/.test(t) ||
    /(?:ver|mostrar|muestra|ense[nñ]a)\s+(?:mi\s+|el\s+)?carrito/.test(t) ||
    /resumen\s+(?:de\s+)?(?:mi\s+|el\s+)?(?:carrito|pedido)/.test(t)
  );
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

/**
 * Referencias al carrito entero o a algo dicho antes: "todo el carrito", "los productos
 * que te dije". No nombran un producto, así que buscarlas en el catálogo siempre falla.
 */
const VAGUE_TARGET_PATTERN =
  /^(?:todo|todos|toda|todas|nada|eso|esto|lo\s+dem[aá]s|el\s+carrito|mi\s+carrito|el\s+pedido|mi\s+pedido|los?\s+productos?|las?\s+cosas?)\b|que\s+te\s+(?:dije|mencione|ped[ií]|comente|pase)|\b(?:anterior(?:mente)?|antes|previo|arriba|mencionados?|los\s+mismos|lo\s+mismo)\b/;

export function isVagueCartTarget(text: string): boolean {
  const t = normalizeProductText(text)
    .replace(/^(?:de\s+|del\s+|los\s+|las\s+|el\s+|la\s+)+/, '')
    .trim();
  if (!t) return true;
  return VAGUE_TARGET_PATTERN.test(t);
}

/**
 * "solo quiero saber el precio" no debe tocar el carrito. Sin `que`: es pronombre relativo
 * en frases legítimas como "solo los que te dije".
 */
const QUESTION_PATTERN =
  /\?|\b(?:cu[aá]nto|cu[aá]l|c[oó]mo|cuando|donde|tienen|hay|precio|vale|cuesta|saber|informacion)\b/;

/** El cliente quita algo puntual, aunque diga "solo": no redefine el carrito. */
const REMOVAL_VERB_PATTERN = /\b(?:quitar|quita|eliminar|elimina|sacar|saca|remover|borrar|borra|vaciar)\b/;

export function isCartCorrectionIntent(text: string): boolean {
  if (isCartKeepOnlyIntent(text)) return false;
  const t = normalizeProductText(text);
  return (
    /no\s+quiero/.test(t) &&
    /(?:solo|solamente|nom[aá]s|nada\s+m[aá]s|unicamente|\bquiero\s+(?:solo|una?|un\b))/.test(t)
  );
}

/**
 * El cliente redefine el carrito completo: "solo quiero la cadena de 45 y el anillo talla 7",
 * "no quiero todo el carrito, solo los dos que te dije". Distinto de una corrección puntual
 * ("no quiero las de 50cm, solo una de 45cm"), que sí conserva el resto del carrito.
 */
export function isCartKeepOnlyIntent(text: string): boolean {
  const t = normalizeProductText(text);
  if (QUESTION_PATTERN.test(t) || REMOVAL_VERB_PATTERN.test(t)) return false;

  // "no quiero todo el carrito, solo …": el rechazo apunta al carrito entero.
  if (
    /no\s+quiero\s+(?:todo|todos|toda|todas|nada)\b/.test(t) &&
    /\b(?:solo|solamente|unicamente)\b/.test(t)
  ) {
    return true;
  }

  if (/^(?:pues\s+|entonces\s+|ok\s+|bueno\s+|mira\s+)?(?:solo|solamente|unicamente)\s+(?:quiero|necesito|deseo|me\s+llevo|llevo|me\s+quedo)\b/.test(t)) {
    return true;
  }

  if (/^(?:me\s+)?(?:quiero|quedo|llevo|necesito|deseo)\s+(?:solo|solamente|unicamente)\b/.test(t)) {
    return true;
  }

  return false;
}

/**
 * Parte del mensaje que describe con qué debe quedarse el carrito. `previousReference`
 * marca los casos en que el cliente apunta a lo último que pidió y no a un producto.
 */
export function parseCartKeepOnly(text: string): { wanted: string; previousReference: boolean } | null {
  if (!isCartKeepOnlyIntent(text)) return null;

  const t = normalizeProductText(text);
  const marker = t.match(/\b(?:solo|solamente|unicamente)\b\s*(.*)$/);
  const rest = (marker?.[1] ?? '')
    .replace(/^(?:quiero|necesito|deseo|me\s+llevo|llevo|me\s+quedo(?:\s+con)?)\s+/, '')
    .trim();

  if (!rest) return null;
  return { wanted: rest, previousReference: isVagueCartTarget(rest) };
}

export function isCartSetQuantityIntent(text: string): boolean {
  if (isCartCorrectionIntent(text) || isCartClearIntent(text)) return false;
  const t = normalizeProductText(text);
  return /deja(?:r)?\s+(?:solo|solamente)|pon(?:er)?\s+\d+|baja(?:r)?\s+a\s+\d+|cambia(?:r)?\s+(?:a\s+)?\d+/.test(
    t
  );
}

/** "ya no quiero el dije de corazón": rechaza un ítem del carrito, no pide el catálogo. */
export function isCartRejectIntent(text: string): boolean {
  if (isCartCorrectionIntent(text) || isCartKeepOnlyIntent(text) || isCartClearIntent(text)) return false;
  const t = normalizeProductText(text);
  if (QUESTION_PATTERN.test(t)) return false;
  return /(?:ya\s+)?no\s+(?:lo\s+|la\s+|los\s+|las\s+)?quiero/.test(t);
}

/** "otra unidad del dije de la virgen": suma 1 a un ítem que ya está en el carrito. */
export function isCartIncrementIntent(text: string): boolean {
  if (
    isCartCorrectionIntent(text) ||
    isCartKeepOnlyIntent(text) ||
    isCartClearIntent(text) ||
    isCartRejectIntent(text) ||
    isCartSetQuantityIntent(text)
  ) {
    return false;
  }
  const t = normalizeProductText(text);
  return /(?:otra|otro)\s+(?:unidad|pieza|mas|m[aá]s)\b|una?\s+m[aá]s\b/.test(t);
}

export function isCartRemoveIntent(text: string): boolean {
  if (isCartClearIntent(text) || isCartCorrectionIntent(text) || isCartSetQuantityIntent(text)) return false;
  const t = normalizeProductText(text);
  return /eliminar|quitar|sacar|remover|borrar/.test(t) || isCartRejectIntent(text);
}

/**
 * "ya no quiero X y quiero otra unidad de Y": quitar una cosa y ajustar otra en el mismo mensaje.
 */
const CART_EDIT_SPLIT =
  /\s+y\s+(?:(?:tambi[eé]n\s+)?(?:quiero|necesito|deseo|agrega(?:r)?|suma(?:r)?|a[nñ]ade(?:r)?|pon(?:er)?))\s+/i;

export function splitCartEditClauses(text: string): { reject: string; want?: string } {
  const trimmed = text.trim();
  const match = trimmed.match(CART_EDIT_SPLIT);
  if (!match || match.index == null) return { reject: trimmed };

  const reject = trimmed.slice(0, match.index).trim();
  const want = trimmed.slice(match.index + match[0].length).trim();
  return want ? { reject, want } : { reject: trimmed };
}

export function isCartIncrementPhrase(text: string): boolean {
  const t = normalizeProductText(text);
  return /(?:otra|otro)\s+(?:unidad|pieza|mas|m[aá]s)\b|una?\s+m[aá]s\b/.test(t);
}

export interface CartCorrectionParts {
  /** Ausente cuando el cliente solo corrige la cantidad ("ya no quiero 3, solo dos de la de 60 cm"). */
  remove?: CartTargetSpec;
  want: CartTargetSpec;
}

export function parseCartCorrection(text: string): CartCorrectionParts | null {
  if (!isCartCorrectionIntent(text)) return null;

  const t = normalizeProductText(text);
  const match = t.match(
    /no\s+quiero\s+(.+?)(?:,\s*)?(?:quiero\s+)?(?:solo|solamente|nom[aá]s|nada\s+m[aá]s|unicamente)\s+(.+)/
  );
  if (!match) return null;

  const remove = extractCartTarget(match[1]!.trim(), 99);
  const want = extractCartTarget(match[2]!.trim(), 1);

  return { remove: hasProductReference(remove) ? remove : undefined, want };
}

export interface CartRemoveRequest {
  target: CartTargetSpec;
  removeAll: boolean;
}

export function parseCartRemove(text: string): CartRemoveRequest {
  const t = normalizeProductText(text);
  const explicitQty = extractQuantityFromText(text, 0);
  const rejectAll = isCartRejectIntent(text) && explicitQty <= 0;
  const removeAll = /todas?|todo|completo/.test(t) || rejectAll;
  const target = extractCartTarget(text, removeAll ? 99 : explicitQty > 0 ? explicitQty : 1);

  return { target, removeAll };
}

/** "deja solo 2 cadenas": el número va tras el verbo, sin unidad que lo delate. */
const QUANTITY_AFTER_VERB =
  /(?:deja(?:r)?\s+(?:solo|solamente)\s+|pon(?:er)?\s+|baja(?:r)?\s+a\s+|cambia(?:r)?\s+(?:a\s+)?)(\d+)\b/;

export function parseCartSetQuantity(text: string): { target: CartTargetSpec; quantity: number } | null {
  if (!isCartSetQuantityIntent(text)) return null;

  const afterVerb = Number.parseInt(normalizeProductText(text).match(QUANTITY_AFTER_VERB)?.[1] ?? '', 10);
  const qtyFromDigits =
    Number.isFinite(afterVerb) && afterVerb > 0 && afterVerb < 100
      ? afterVerb
      : extractQuantityFromText(text, 0);
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
