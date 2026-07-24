/** Utilidades genéricas para selección de productos (cualquier catálogo WooCommerce). */

/** Atributos de variación mencionados en texto libre (medida, peso, talla, color, etc.). */
export const VARIANT_HINT_PATTERN =
  /\b(?:de\s+|talla\s+|medida\s+|size\s+|modelo\s+|color\s+)?(\d+\s*(?:cm|mm|gr?|kt|k|ml|oz|lb)|talla\s+[xsml\d]+|#\s*\d+)\b/i;

/** Colores y tallas textuales comunes en variaciones WooCommerce. */
export const COLOR_HINT_PATTERN =
  /\b(?:color\s+)?(rojo|azul|verde|negro|blanco|dorado|plateado|rosado|morado|amarillo|gris|beige|marron|marr[oó]n|nude|celeste)\b/i;

export const TEXT_SIZE_HINT_PATTERN = /\b(?:talla\s+|size\s+)([xsml\d]{1,3}|[\wáéíóúñ]+)\b/i;

/** Palabras sueltas que no son nombre de producto al buscar en carrito activo. */
export const SELECTION_NOISE_WORDS = /^(otra|otro|misma|mismo|más|mas|de|en|la|el|un|una|agregar|a[nñ]adir)$/i;

/** Fragmentos a quitar del nombre de producto al buscar (no son nombres de producto). */
export const VARIANT_STRIP_PATTERN =
  /\b(?:de\s+|talla\s+|medida\s+|size\s+)?(\d+\s*(?:cm|mm|gr?|kt|k|ml|oz|lb)|talla\s+[xsml\d]+|#\s*\d+)\b/gi;

export const PURCHASE_INTENT_PATTERN =
  /quiero|me gustar[ií]a|quisiera|dame|necesito|comprar|llevar|tomar|pedir|solicito/i;

export const QUANTITY_PATTERN =
  /\b(\d+)\s*(?:ud?s?\.?|unidades?|pares?|piezas?|pzs?)\b|(?:cantidad|qty|x)\s*(\d+)\b/i;

export const SKU_LIKE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,}$/;

export const SEARCH_STOP_WORDS =
  /^(de|en|la|el|los|las|un|una|uno|del|con|por|para|y|o|the|a|an)$/i;

export function normalizeProductText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractVariantHint(text: string): string | undefined {
  const matches = [...text.matchAll(new RegExp(VARIANT_HINT_PATTERN.source, 'gi'))];
  const last = matches.at(-1);
  if (last?.[1]) return last[1].replace(/\s+/g, ' ').trim();

  const color = text.match(COLOR_HINT_PATTERN);
  if (color?.[1]) return color[1].trim();

  const textSize = text.match(TEXT_SIZE_HINT_PATTERN);
  if (textSize?.[1]) return textSize[1].trim();

  return undefined;
}

/** Cliente pide otro ítem del mismo producto base (ej. "otra de la misma pero 60cm"). */
export function isSameProductReference(text: string): boolean {
  const t = normalizeProductText(text);
  return /tambi[eé]n|otra?|m[aá]s|del mismo|de la misma|igual|mismo producto|misma/.test(t);
}

/** Mensaje corto con variante/atributo y carrito activo → misma familia de producto. */
export function isCartSiblingVariantIntent(text: string, cartHasItems: boolean): boolean {
  if (!cartHasItems) return false;
  const variantHint = extractVariantHint(text);
  if (!variantHint) return false;
  if (isSameProductReference(text)) return true;

  const t = normalizeProductText(text);
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  // Ej. "45 cm", "talla M", "en rojo", "otra de 45 cm"
  if (wordCount <= 8 && !/^(qu[eé]|cu[aá]les|cu[aá]nto|hay|tienen|muestr)/.test(t)) {
    return true;
  }
  return false;
}

/** Texto describe un producto concreto (no solo "agregar algo más"). */
export function hasConcreteProductSpec(text: string): boolean {
  const t = normalizeProductText(text);
  if (extractVariantHint(text)) return true;
  if (looksLikeSku(text.trim())) return true;
  const tokens = tokenizeProductQuery(text);
  return tokens.length >= 2 && PURCHASE_INTENT_PATTERN.test(t);
}

export function parseProductSelectionQuery(query: string): { productQuery: string; variantHint?: string } {
  const variantHint = extractVariantHint(query);
  const productQuery = query
    .replace(
      /^(me gustar[ií]a|quisiera|quiero|busco|necesito|dame|comprar|llevar|tomar|pedir|solicito|tambi[eé]n|una?\s+|un\s+|la\s+|el\s+|los\s+|las\s+|otra?\s+|m[aá]s\s+)/gi,
      ''
    )
    .replace(/\b(tambi[eé]n|otra?|m[aá]s|del mismo|de la misma|pero|igual|mismo|misma)\b/gi, '')
    .replace(VARIANT_STRIP_PATTERN, '')
    .replace(QUANTITY_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { productQuery: productQuery || query.trim(), variantHint };
}

export function extractQuantityFromText(text: string, defaultQty = 1): number {
  const match = text.match(QUANTITY_PATTERN);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return defaultQty;
  const qty = Number.parseInt(raw, 10);
  if (!Number.isFinite(qty) || qty < 1 || qty > 99) return defaultQty;
  return qty;
}

export function looksLikeSku(text: string): boolean {
  const trimmed = text.trim();
  return SKU_LIKE_PATTERN.test(trimmed) && !/\s/.test(trimmed);
}

export function tokenizeProductQuery(text: string): string[] {
  return normalizeProductText(text)
    .split(/\s+/)
    .filter((word) => word.length > 1 && !SEARCH_STOP_WORDS.test(word));
}
