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

/** Corrige typos frecuentes en WhatsApp antes de interpretar intents. */
export function normalizeUserTypos(text: string): string {
  return text
    .replace(/\bagreag(?:ar|r)\b/gi, 'agregar')
    .replace(/\banil[llo]+\b/gi, 'anillo')
    .replace(/\bcadenas\b/gi, 'cadena');
}

export const PRODUCT_FAMILY_PATTERN =
  /\b(cadena|cadenas|anillo|anillos|arete|aretes|collar|collares|pulsera|pulseras|bal[ií]n|balines|dije|dijes|argolla|argollas|aro|aros)\b/i;

/**
 * Códigos de producto inequívocos ("CAD-ORO-45"): con dígito y separador o mayúsculas.
 * `looksLikeSku` por sí solo acepta cualquier palabra ("unidades", "quiero").
 */
export function looksLikeExplicitSku(token: string): boolean {
  if (!looksLikeSku(token) || !/\d/.test(token)) return false;
  return /[-_.]/.test(token) || /[A-Z]{2,}/.test(token);
}

export function extractExplicitSkus(text: string): string[] {
  return [...text.matchAll(/\b[A-Za-z0-9][A-Za-z0-9._-]{2,}\b/g)]
    .map((match) => match[0])
    .filter(looksLikeExplicitSku);
}

function splitSegments(text: string, separator: RegExp): string[] {
  return text
    .split(separator)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 3);
}

/** Varios productos en un mensaje: "cadena 45cm y anillo talla 12", "CAD-ORO-45 y CAD-ORO-50". */
export function parseMultiProductSelection(text: string): string[] | null {
  const normalized = normalizeUserTypos(text);

  // Con códigos explícitos no hace falta reconocer la familia del producto.
  const codeSegments = splitSegments(normalized, /\s*,\s*|\s+y\s+/i);
  if (codeSegments.filter((segment) => extractExplicitSkus(segment).length).length >= 2) {
    return codeSegments;
  }

  if (!/\s+y\s+/i.test(normalized)) return null;

  const segments = splitSegments(normalized, /\s+y\s+/i);
  if (segments.length < 2) return null;

  const families = segments.map((segment) => {
    const match = segment.match(PRODUCT_FAMILY_PATTERN);
    return match?.[1]?.toLowerCase().replace(/s$/, '');
  });

  const distinctFamilies = new Set(families.filter(Boolean));
  if (distinctFamilies.size >= 2) return segments;

  const allFamilies = [...normalized.matchAll(new RegExp(PRODUCT_FAMILY_PATTERN.source, 'gi'))].map((m) =>
    m[1]!.toLowerCase().replace(/s$/, '')
  );
  if (new Set(allFamilies).size >= 2) return segments;

  return null;
}

/**
 * Preguntas por catálogo, productos o precios en general. Se responden con el enlace de la tienda.
 * Si el mensaje nombra un tipo concreto (cadena, anillo…), usar `isProductFamilyBrowseIntent`.
 */
export function isCatalogBrowseIntent(text: string): boolean {
  if (isProductFamilyBrowseIntent(text)) return false;

  const t = normalizeProductText(normalizeUserTypos(text));
  return (
    /^(qu[eé]|cu[aá]les|cu[aá]nto|tienen|tienes|hay|muestr|list|inform|cat[aá]logo|precio|venden|manejan|que\s+venden)/.test(t) ||
    /qu[eé]\s+productos\s+(tienen|hay|venden|manejan)/.test(t) ||
    /productos?\s+(tienen|tienes|hay|venden|disponibles|manejan)/.test(t) ||
    /\b(cat[aá]logo|precios|lista\s+de\s+precios|ver\s+(los\s+)?productos)\b/.test(t)
  );
}

/** Tipo de producto mencionado (cadena, anillo, arete…). Singular, sin plural final. */
export function extractProductFamilyTerm(text: string): string | null {
  const match = normalizeUserTypos(text).match(PRODUCT_FAMILY_PATTERN);
  if (!match?.[1]) return null;
  return match[1].toLowerCase().replace(/s$/, '');
}

/**
 * Cliente pregunta por un tipo de producto concreto (no catálogo general).
 * Ej.: "quiero una cadena", "tienen anillos", "me interesa un arete".
 */
export function isProductFamilyBrowseIntent(text: string): boolean {
  if (extractExplicitSkus(text).length) return false;

  const family = extractProductFamilyTerm(text);
  if (!family) return false;

  const t = normalizeProductText(normalizeUserTypos(text)).trim();

  // Solo catálogo general, sin tipo de producto.
  if (/^(cat[aá]logo|ver\s+cat[aá]logo|lista\s+de\s+precios)$/.test(t)) return false;
  if (/^qu[eé]\s+productos\s+(tienen|hay|venden|manejan)/.test(t)) return false;

  return true;
}

export function extractVariantHint(text: string): string | undefined {
  const all = extractAllVariantHints(text);
  if (all.length) return all.at(-1);

  const color = text.match(COLOR_HINT_PATTERN);
  if (color?.[1]) return color[1].trim();

  const textSize = text.match(TEXT_SIZE_HINT_PATTERN);
  if (textSize?.[1]) return textSize[1].trim();

  return undefined;
}

/** Todas las medidas/variantes mencionadas (ej. "45cm y otra de 50cm" → ambas). */
export function extractAllVariantHints(text: string): string[] {
  const matches = [...text.matchAll(new RegExp(VARIANT_HINT_PATTERN.source, 'gi'))];
  const hints = matches
    .map((match) => match[1]?.replace(/\s+/g, ' ').trim())
    .filter((hint): hint is string => !!hint);

  return [...new Set(hints)];
}

/** Detecta pedido con varias medidas/variantes en un solo mensaje (mismo producto). */
export function parseMultiVariantSelection(text: string): { baseQuery: string; variantHints: string[] } | null {
  if (parseMultiProductSelection(text)) return null;

  const variantHints = extractAllVariantHints(text);
  if (variantHints.length < 2) return null;

  const hasMultiCue =
    /\s+y\s+(?:otra?|una?|un\b)/i.test(text) ||
    variantHints.length >= 2;

  if (!hasMultiCue) return null;

  const baseQuery = text
    .replace(
      /^(me gustar[ií]a|quisiera|quiero|busco|necesito|dame|comprar|llevar|tomar|pedir|solicito|agregar|a[nñ]adir|una?\s+|un\s+|la\s+|el\s+|los\s+|las\s+)/gi,
      ''
    )
    .replace(/\s+y\s+(?:otra?\s*(?:de\s+)?|una?\s*(?:de\s+)?|un\s+(?:de\s+)?)[^.!?]*$/gi, '')
    .replace(VARIANT_STRIP_PATTERN, '')
    .replace(QUANTITY_PATTERN, '')
    .replace(/\b(tambi[eé]n|otra?|m[aá]s|del mismo|de la misma|pero|igual|mismo|misma)\b/gi, '')
    .replace(/\s+de\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!baseQuery || baseQuery.length < 3) return null;

  return { baseQuery, variantHints };
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
  if (/^(qu[eé]|cu[aá]les|cu[aá]nto|hay|tienen|muestr)/.test(t)) return false;

  if (/\b(agregar|a[nñ]adir)\b/.test(t) && PURCHASE_INTENT_PATTERN.test(t)) return true;

  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 15) return true;
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
      /^(me gustar[ií]a|quisiera|quiero|busco|necesito|dame|comprar|llevar|tomar|pedir|solicito|agregar|a[nñ]adir|tambi[eé]n|una?\s+|un\s+|la\s+|el\s+|los\s+|las\s+|otra?\s+|m[aá]s\s+)/gi,
      ''
    )
    .replace(/\b(tambi[eé]n|otra?|m[aá]s|del mismo|de la misma|pero|igual|mismo|misma)\b/gi, '')
    .replace(VARIANT_STRIP_PATTERN, '')
    .replace(QUANTITY_PATTERN, '')
    .replace(/\s+de\s*$/i, '')
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

/** Compara medidas/variantes tolerando "45 cm" vs "45cm". */
export function variantHintsMatch(a: string, b: string): boolean {
  const compact = (value: string) =>
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/\s+/g, '')
      .replace(/[^\da-z#]/gi, '');
  const left = compact(a);
  const right = compact(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

export function cartItemMatchesVariantHint(item: { name: string; sku: string }, hint: string): boolean {
  const blob = normalizeProductText(`${item.name} ${item.sku}`);
  return variantHintsMatch(blob, hint);
}

export function tokenizeProductQuery(text: string): string[] {
  return normalizeProductText(text)
    .split(/\s+/)
    .filter((word) => word.length > 1 && !SEARCH_STOP_WORDS.test(word));
}
