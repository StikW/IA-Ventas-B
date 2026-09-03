/** Utilidades genéricas para selección de productos (cualquier catálogo WooCommerce). */

/**
 * Atributos de variación mencionados en texto libre, en orden de especificidad.
 *
 * Los valores reales de WooCommerce son heterogéneos: "10 x 9 mm", "8 × 7 mm" (con el signo
 * ×), tallas fraccionarias "7 1/2" o "91/4", pesos "1,1 g", tamaños cualitativos
 * ("Grande 15 MM") y colores en femenino/plural. Se recorren de más específico a más
 * general enmascarando lo ya capturado, para que "10 x 9 mm" no se reduzca a "9 mm".
 */
const DIMENSION_HINT_PATTERN = /\d+(?:[.,]\d+)?\s*[x×]\s*\d+(?:[.,]\d+)?(?:\s*(?:cm|mm))?/;
const FRACTION_HINT_PATTERN = /\d{1,2}\s*\d?\s*\/\s*\d/;
const MEASURE_HINT_PATTERN = /\d+(?:[.,]\d+)?\s*(?:cm|mm|gr|g|kt|k|ml|oz|lb)\b/;
const HASH_HINT_PATTERN = /#\s*\d+/;
const LABELED_SIZE_HINT_PATTERN =
  /(?:talla|tamano|tama[nñ]o|size|medida|modelo)\s*:?\s*([a-z\d./#-]+)/;
const QUALITATIVE_SIZE_HINT_PATTERN =
  /\b(extra\s?grande|grande|mediana|mediano|media|medio|peque[nñ]a|peque[nñ]o|mini|chica|chico)\b/;
const COLOR_HINT_PATTERN_SOURCE =
  /\b(?:color\s+)?(rojas?|rojos?|azul(?:es)?|verdes?|negr[oa]s?|blanc[oa]s?|dorad[oa]s?|platead[oa]s?|rosad[oa]s?|rosa|morad[oa]s?|lilas?|fucsias?|amarill[oa]s?|gris(?:es)?|beige|marr[oó]n(?:es)?|nude|celeste|turquesa|violeta|naranja)\b/;
/** Último recurso: "talla 8", "el de 12" sin unidad, sin confundir con cantidades. */
const BARE_SIZE_HINT_PATTERN =
  /\b(?:de|talla|tamano|tama[nñ]o|numero|n[uú]mero)\s+(\d{1,2})(?!\s*(?:ud|uds|unidad|unidades|par|pares|pieza|piezas|cm|mm|gr|g)\b)/;

const ORDERED_HINT_PATTERNS = [
  DIMENSION_HINT_PATTERN,
  FRACTION_HINT_PATTERN,
  MEASURE_HINT_PATTERN,
  HASH_HINT_PATTERN,
  LABELED_SIZE_HINT_PATTERN,
  QUALITATIVE_SIZE_HINT_PATTERN,
  COLOR_HINT_PATTERN_SOURCE,
  BARE_SIZE_HINT_PATTERN,
];

/** Mantenido por compatibilidad: coincide con la forma más común (medida con unidad). */
export const VARIANT_HINT_PATTERN = MEASURE_HINT_PATTERN;

export const COLOR_HINT_PATTERN = COLOR_HINT_PATTERN_SOURCE;

export const TEXT_SIZE_HINT_PATTERN = LABELED_SIZE_HINT_PATTERN;

/** Palabras sueltas que no son nombre de producto al buscar en carrito activo. */
export const SELECTION_NOISE_WORDS = /^(otra|otro|misma|mismo|más|mas|de|en|la|el|un|una|agregar|a[nñ]adir)$/i;

/** Fragmentos a quitar del nombre de producto al buscar (no son nombres de producto). */
export const VARIANT_STRIP_PATTERN = new RegExp(
  [
    DIMENSION_HINT_PATTERN.source,
    FRACTION_HINT_PATTERN.source,
    MEASURE_HINT_PATTERN.source,
    HASH_HINT_PATTERN.source,
    /(?:talla|tamano|tama[nñ]o|size|medida)\s*:?\s*[a-z\d./#-]+/.source,
  ].join('|'),
  'gi'
);

export const PURCHASE_INTENT_PATTERN =
  /quiero|me gustar[ií]a|quisiera|dame|necesito|comprar|llevar|tomar|pedir|solicito/i;

const ADD_VERB_PATTERN = /\b(?:agrega|agregar|a[nñ]ade|a[nñ]adir)\b/;

/** "quiero saber si tienen" sigue siendo consulta, no pedido. */
const PURCHASE_AS_QUESTION_PATTERN = /\b(?:saber|conocer|consultar|ver|preguntar)\s+si\b/;

/**
 * El cliente pide agregar o llevar un producto (no solo pregunta si existe).
 * "quiero saber si tienen balines" no cuenta.
 */
export function hasExplicitPurchaseIntent(text: string): boolean {
  const t = normalizeProductText(normalizeUserTypos(text));
  if (PURCHASE_AS_QUESTION_PATTERN.test(t)) return false;
  return PURCHASE_INTENT_PATTERN.test(t) || ADD_VERB_PATTERN.test(t);
}

/**
 * Pregunta de disponibilidad o listado: "tienen balines #4", "hay anillos?", "venden dijes".
 * No implica agregar al carrito aunque el mensaje nombre medida o SKU.
 */
export function isAvailabilityQuestion(text: string): boolean {
  if (hasExplicitPurchaseIntent(text)) return false;
  const t = normalizeProductText(normalizeUserTypos(text));
  return (
    /^(qu[eé]|cu[aá]les|cu[aá]nto|tienen|tienes|hay|venden|manejan|muestr|existen?|me\s+muestras)/.test(
      t
    ) || /\b(?:tienen|tienes|hay|venden|existe|existen|disponible|disponibles)\b/.test(t)
  );
}

/**
 * Variante + tipo de producto, pero el cliente está pidiendo (no preguntando).
 * "quiero balín #4" → true. "tienen balines #4" → false.
 */
export function isDirectVariantAddIntent(text: string): boolean {
  return (
    Boolean(extractVariantHint(text)) &&
    !isProductOptionsBrowseIntent(text) &&
    !isAvailabilityQuestion(text)
  );
}

export const QUANTITY_PATTERN =
  /\b(\d+)\s*(?:unds?\.?|uds?\.?|unidades?|pares?|piezas?|pzs?|balines?|canutillos?)\b|(?:cantidad|qty|x)\s*(\d+)\b/i;

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

/**
 * Marcas de formato de WhatsApp (`*negrita*`, `_cursiva_`, `~tachado~`, `` `código` ``).
 * El cliente copia los *ID* que el agente resalta en negrita y los reenvía con asteriscos.
 */
export function stripWhatsAppFormatting(text: string): string {
  return text.replace(/[*_~`]+/g, '');
}

/** Corrige typos frecuentes en WhatsApp antes de interpretar intents. */
export function normalizeUserTypos(text: string): string {
  return stripWhatsAppFormatting(text)
    .replace(/\bagreag(?:ar|r)\b/gi, 'agregar')
    .replace(/\banil[llo]+\b/gi, 'anillo')
    .replace(/\bcadenas\b/gi, 'cadena');
}

/**
 * Tipos de producto conocidos de partida. La lista real la aporta el catálogo del negocio
 * vía `registerCatalogFamilyTerms`, porque cada tienda nombra sus categorías distinto
 * (en MASSI los aretes se llaman «topos» y hay familias como «herraje» o «canutillo»).
 */
const BASE_FAMILY_TERMS = [
  'cadena',
  'anillo',
  'arete',
  'topo',
  'topito',
  'candonga',
  'zarcillo',
  'collar',
  'gargantilla',
  'pulsera',
  'esclava',
  'manilla',
  'balin',
  'dije',
  'colgante',
  'medalla',
  'herraje',
  'broche',
  'canutillo',
  'tambor',
  'placa',
  'argolla',
  'sortija',
  'aro',
];

const catalogFamilyTerms = new Set<string>(BASE_FAMILY_TERMS);

/** Términos de familia detectados en el catálogo real del negocio (categorías WooCommerce). */
export function registerCatalogFamilyTerms(terms: string[]): void {
  for (const term of terms) {
    const normalized = normalizeProductText(term);
    if (normalized.length >= 4) catalogFamilyTerms.add(normalized);
  }
}

export function knownFamilyTerms(): string[] {
  return [...catalogFamilyTerms];
}

/** "dijes" ↔ "dije", "balines" ↔ "balin", "cruces" ↔ "cruz". */
export function tokensRelated(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  const deCes = (value: string) => (value.endsWith('ces') ? `${value.slice(0, -3)}z` : value);
  return deCes(a) === deCes(b);
}

export const PRODUCT_FAMILY_PATTERN =
  /\b(cadena|cadenas|anillo|anillos|arete|aretes|topo|topos|topito|topitos|candonga|candongas|zarcillo|zarcillos|collar|collares|gargantilla|gargantillas|pulsera|pulseras|esclava|esclavas|manilla|manillas|bal[ií]n|balines|dije|dijes|colgante|colgantes|medalla|medallas|herraje|herrajes|broche|broches|canutillo|canutillos|tambor|tambores|placa|placas|argolla|argollas|sortija|sortijas|aro|aros)\b/i;

/**
 * Códigos de producto inequívocos ("CAD-ORO-45", "DCOMAT002").
 * `looksLikeSku` por sí solo acepta cualquier palabra ("unidades", "quiero").
 * El cliente a menudo reescribe el ID en minúsculas ("dcomat002").
 */
export function looksLikeExplicitSku(token: string): boolean {
  if (!looksLikeSku(token) || !/\d/.test(token)) return false;
  if (/[-_.]/.test(token)) return true;
  return /[A-Za-z]{2,}/.test(token) && token.length >= 6;
}

export function extractExplicitSkus(text: string): string[] {
  return [...stripWhatsAppFormatting(text).matchAll(/\b[A-Za-z0-9][A-Za-z0-9._-]{2,}\b/g)]
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
  if (hasThemeOrShapeQuery(text)) return false;

  const t = normalizeProductText(normalizeUserTypos(text));
  return (
    /^(qu[eé]|cu[aá]les|cu[aá]nto|tienen|tienes|hay|muestr|list|inform|cat[aá]logo|precio|venden|manejan|que\s+venden)/.test(t) ||
    /qu[eé]\s+productos\s+(tienen|hay|venden|manejan)/.test(t) ||
    /productos?\s+(tienen|tienes|hay|venden|disponibles|manejan)/.test(t) ||
    /\b(cat[aá]logo|precios|lista\s+de\s+precios|ver\s+(los\s+)?productos)\b/.test(t)
  );
}

/**
 * Tipo de producto mencionado (dije, topo, herraje…). Se compara contra las familias
 * conocidas del catálogo, así que basta con que el negocio publique la categoría.
 */
export function extractProductFamilyTerm(text: string): string | null {
  for (const token of tokenizeProductQuery(normalizeUserTypos(text))) {
    for (const family of catalogFamilyTerms) {
      if (tokensRelated(token, family)) return token;
    }
  }

  const match = normalizeUserTypos(text).match(PRODUCT_FAMILY_PATTERN);
  if (!match?.[1]) return null;
  return normalizeProductText(match[1]).replace(/s$/, '');
}

/**
 * Cliente pregunta por un tipo de producto concreto (no catálogo general).
 * Ej.: "quiero una cadena", "tienen anillos", "me interesa un arete".
 */
export function isProductFamilyBrowseIntent(text: string): boolean {
  if (extractExplicitSkus(text).length) return false;
  if (hasThemeOrShapeQuery(text)) return false;

  const t = normalizeProductText(normalizeUserTypos(text));
  // Ajustes de carrito: no abrir el listado de la familia.
  if (/(?:ya\s+)?no\s+(?:lo\s+|la\s+|los\s+|las\s+)?quiero/.test(t)) return false;
  if (/(?:otra|otro)\s+(?:unidad|pieza|mas|m[aá]s)\b|una?\s+m[aá]s\b/.test(t)) return false;

  const family = extractProductFamilyTerm(text);
  if (!family) return false;

  // Solo catálogo general, sin tipo de producto.
  if (/^(cat[aá]logo|ver\s+cat[aá]logo|lista\s+de\s+precios)$/.test(t)) return false;
  if (/^qu[eé]\s+productos\s+(tienen|hay|venden|manejan)/.test(t)) return false;

  return true;
}

/**
 * El cliente pide las variaciones de un producto ya nombrado, no un listado de la familia.
 * Ej.: "qué opciones tienes del anillo dama flor con circones".
 */
export function isProductOptionsBrowseIntent(text: string): boolean {
  const t = normalizeProductText(normalizeUserTypos(text));
  return (
    /\b(?:opciones|variaciones|tallas|medidas|colores)\b/.test(t) ||
    /\bqu[eé]\s+(?:tienes|tienen|hay)\s+(?:de|del|de\s+la)\b/.test(t)
  );
}

/**
 * Motivo o silueta: "en forma de virgen", "figura de corazón".
 * No depende de cómo empiece la frase ("tienen…", "busco…").
 */
export function hasThemeOrShapeQuery(text: string): boolean {
  const t = normalizeProductText(normalizeUserTypos(text));
  return /\bforma\s+de\b/.test(t) || /\bfiguras?\s+de\b/.test(t) || /\bmotivo\s+de\b/.test(t);
}

/** Etiqueta corta para el listado: "joyas en forma de animales" → "animales". */
export function themeListLabel(text: string, fallbackTokens: string[] = []): string {
  const t = normalizeProductText(normalizeUserTypos(text));
  const shape = t.match(/\b(?:forma|figura|figuras|motivo)\s+de\s+(.+?)(?:\s*\?|$)/);
  const label = shape?.[1]?.replace(/\b(hay|tienen|tienes|disponibles?)\b/g, '').trim();
  return label || fallbackTokens.join(' ') || 'eso que buscas';
}

/**
 * Pregunta por un motivo o forma, no por un tipo de producto: "alguna joya en forma de corazón".
 * Si nombra una familia ("tienen dijes") se usa el listado de familia, no este camino.
 */
export function isThemeBrowseIntent(text: string): boolean {
  if (extractExplicitSkus(text).length) return false;
  if (isProductFamilyBrowseIntent(text)) return false;
  return hasThemeOrShapeQuery(text);
}

/** Menciones al surtido en general, que por sí solas no describen ningún motivo. */
const GENERIC_CATALOG_WORDS = /\b(joya|joyas|joyeria|producto|productos|articulo|articulos|pieza|piezas|modelo|modelos|diseno|disenos|cosa|cosas|algo)\b/;

/**
 * El cliente describe un motivo ("tienen joyas de animales", "algo religioso") sin nombrar
 * un tipo de producto ni un ID. No se decide aquí si existe: el catálogo del negocio es
 * quien manda, así que el agente intenta el listado y, si no hay nada, sigue su curso.
 */
export function isThemeBrowseCandidate(text: string): boolean {
  if (extractExplicitSkus(text).length) return false;
  if (isProductFamilyBrowseIntent(text)) return false;
  if (hasThemeOrShapeQuery(text)) return true;

  const t = normalizeProductText(normalizeUserTypos(text));
  const asksForCatalog =
    isAvailabilityQuestion(text) || isCatalogBrowseIntent(text) || GENERIC_CATALOG_WORDS.test(t);

  return asksForCatalog && themeQueryTokens(text).length > 0;
}

/**
 * Palabras que describen el motivo, sin el tipo de producto ni el relleno de la pregunta.
 * "tienen joyas de animales" → ["animales"].
 */
export function themeQueryTokens(text: string): string[] {
  return tokenizeProductQuery(normalizeUserTypos(text)).filter(
    (token) =>
      token.length >= 4 &&
      !/^\d+$/.test(token) &&
      !GENERIC_CATALOG_WORDS.test(token) &&
      !THEME_QUERY_NOISE.test(token) &&
      ![...catalogFamilyTerms].some((family) => tokensRelated(token, family))
  );
}

const THEME_QUERY_NOISE =
  /^(tienen|tienes|tiene|hay|venden|manejan|muestra|mostrar|muestrame|listar|alguna|alguno|algunas|algunos|forma|formas|figura|figuras|motivo|busco|buscas|buscan|disponible|disponibles|quiero|quisiera|gustaria|interesa|interesan|para|con|sobre|tema|estilo|tipo|clase|acerca|informacion|precio|precios|catalogo)$/;

/**
 * El cliente cambió de tema (listado, catálogo, otro motivo…) mientras había un balín
 * pendiente de cantidad o una cotización abierta. Hay que descartar ese estado.
 */
export function shouldAbandonPendingPackFlow(text: string): boolean {
  return (
    isProductFamilyBrowseIntent(text) ||
    isThemeBrowseCandidate(text) ||
    isCatalogBrowseIntent(text)
  );
}

/** Señala otro producto distinto al que está pendiente de cotización. */
export function mentionsDifferentPackProduct(
  text: string,
  pending: { sku: string; name: string }
): boolean {
  const pendingSku = pending.sku.trim().toUpperCase();
  const otherSku = extractExplicitSkus(text).find((sku) => sku.toUpperCase() !== pendingSku);
  if (otherSku) return true;

  const hint = extractVariantHint(text);
  if (!hint) return false;

  const normalizedHint = normalizeProductText(hint.replace(/^#/, ''));
  const normalizedName = normalizeProductText(pending.name);
  if (normalizedName.includes(normalizedHint)) return false;

  // Balín #3 vs Balín #7: el hint numérico no aparece en el nombre del pendiente.
  if (/^\d+$/.test(normalizedHint) && /\b#?\d+\b/.test(normalizedName)) {
    return !normalizedName.includes(normalizedHint);
  }

  return normalizedHint.length >= 2;
}

export function extractVariantHint(text: string): string | undefined {
  return extractAllVariantHints(text).at(-1);
}

/**
 * Todas las medidas/variantes mencionadas (ej. "45cm y otra de 50cm" → ambas).
 * Recorre los patrones de más específico a más general enmascarando lo ya capturado.
 */
export function extractAllVariantHints(text: string): string[] {
  let remaining = normalizeProductText(text);
  const found: Array<{ hint: string; at: number }> = [];

  for (const pattern of ORDERED_HINT_PATTERNS) {
    const global = new RegExp(pattern.source, 'gi');
    const spans: Array<[number, number]> = [];
    let match: RegExpExecArray | null;

    while ((match = global.exec(remaining)) !== null) {
      if (!match[0].length) break;
      const hint = (match[1] ?? match[0]).replace(/\s+/g, ' ').trim();
      if (hint && !SEARCH_STOP_WORDS.test(hint)) found.push({ hint, at: match.index });
      spans.push([match.index, match.index + match[0].length]);
    }

    // El enmascarado conserva la longitud, así que las posiciones siguen siendo válidas.
    for (const [start, end] of spans.reverse()) {
      remaining = remaining.slice(0, start) + ' '.repeat(end - start) + remaining.slice(end);
    }
  }

  // Orden del mensaje, no de los patrones: "45 cm y otra de 60 cm" debe terminar en 60 cm.
  return [...new Set(found.sort((a, b) => a.at - b.at).map((entry) => entry.hint))];
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
  if (isAvailabilityQuestion(text)) return false;
  if (/^(qu[eé]|cu[aá]les|cu[aá]nto|hay|tienen|muestr)/.test(t)) return false;

  if (/\b(agregar|a[nñ]adir)\b/.test(t) && PURCHASE_INTENT_PATTERN.test(t)) return true;

  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 15) return true;
  return false;
}

/** Texto describe un producto concreto (no solo "agregar algo más"). */
export function hasConcreteProductSpec(text: string): boolean {
  if (isAvailabilityQuestion(text)) return false;
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
  // "Promo x5" y "10 x 9 mm" son nombres de variación, no cantidades.
  const sanitized = text
    .replace(/\bpromo\s*x\s*\d+/gi, ' ')
    .replace(/\d+(?:[.,]\d+)?\s*[x×]\s*\d+(?:[.,]\d+)?/gi, ' ');

  const match = sanitized.match(QUANTITY_PATTERN);
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

function compactVariant(value: string): string {
  return normalizeProductText(value)
    .replace(/\s+/g, '')
    .replace(/[^\da-z#/.]/g, '');
}

/**
 * Medidas presentes en un texto, como unidades comparables: "10 x 9 mm" → `10x9mm`,
 * "7 1/2" → `71/2`. Sin esto, comparar por subcadena hace que la talla 5 coincida
 * con "5 1/2", "15" o "0.95 g".
 */
function variantTokens(text: string): string[] {
  let remaining = normalizeProductText(text);
  const tokens: string[] = [];

  for (const pattern of [
    DIMENSION_HINT_PATTERN,
    FRACTION_HINT_PATTERN,
    MEASURE_HINT_PATTERN,
    HASH_HINT_PATTERN,
  ]) {
    const global = new RegExp(pattern.source, 'gi');
    const spans: Array<[number, number]> = [];
    let match: RegExpExecArray | null;

    while ((match = global.exec(remaining)) !== null) {
      if (!match[0].length) break;
      tokens.push(compactVariant(match[0]));
      spans.push([match.index, match.index + match[0].length]);
    }

    for (const [start, end] of spans.reverse()) {
      remaining = remaining.slice(0, start) + ' '.repeat(end - start) + remaining.slice(end);
    }
  }

  for (const bare of remaining.matchAll(/\d+(?:[.,]\d+)?/g)) {
    tokens.push(compactVariant(bare[0]));
  }

  return tokens.filter(Boolean);
}

function leadingNumber(token: string): string | null {
  return token.match(/^\d+(?:\.\d+)?/)?.[0] ?? null;
}

/** Compara medidas/variantes tolerando "45 cm" vs "45cm" y colores en plural. */
export function variantHintsMatch(a: string, b: string): boolean {
  const left = compactVariant(a);
  const right = compactVariant(b);
  if (!left || !right) return false;
  if (left === right) return true;

  const tokensA = variantTokens(a);
  const tokensB = variantTokens(b);

  if (tokensA.length && tokensB.length) {
    for (const ta of tokensA) {
      for (const tb of tokensB) {
        if (ta === tb) return true;
        // Número sin unidad ("el de 10") frente a la medida completa ("10 mm").
        if (/^\d+(?:\.\d+)?$/.test(tb) && leadingNumber(ta) === tb) return true;
        if (/^\d+(?:\.\d+)?$/.test(ta) && leadingNumber(tb) === ta) return true;
        // "10x9mm" contiene "9mm": el cliente puede omitir una dimensión.
        if (tb.length >= 3 && ta.includes(tb)) return true;
        if (ta.length >= 3 && tb.includes(ta)) return true;
      }
    }
    return false;
  }

  // Variantes por palabra (colores, tamaños cualitativos). Solo si el término es corto:
  // comparar frases completas produciría falsos positivos.
  const wordsA = tokenizeProductQuery(a);
  const wordsB = tokenizeProductQuery(b);
  if (!wordsA.length || !wordsB.length) return false;

  const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const longer = shorter === wordsA ? wordsB : wordsA;
  if (shorter.length > 3) return false;

  return shorter.every((word) => longer.some((candidate) => tokensRelated(candidate, word)));
}

export function cartItemMatchesVariantHint(item: { name: string; sku: string }, hint: string): boolean {
  const blob = normalizeProductText(`${item.name} ${item.sku}`);
  return variantHintsMatch(blob, hint);
}

export function tokenizeProductQuery(text: string): string[] {
  return normalizeProductText(text)
    .split(/\s+/)
    // La puntuación de WhatsApp ("dijes?", "cadena,") no forma parte del término.
    .map((word) => word.replace(/^[^a-z0-9#]+/g, '').replace(/[^a-z0-9]+$/g, ''))
    .filter((word) => word.length > 1 && !SEARCH_STOP_WORDS.test(word));
}
