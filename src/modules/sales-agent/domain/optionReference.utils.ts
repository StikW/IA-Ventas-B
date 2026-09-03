/**
 * Referencias posicionales al último listado que vio el cliente: «el primero», «la
 * segunda», «el último», «la opción 3». Sin esto el agente manda esas frases al LLM, que
 * no sabe qué se listó y termina agregando el producto padre completo al carrito.
 */

import { OfferedOption } from './IChatSessionRepository';
import {
  extractQuantityFromText,
  isProductOptionsBrowseIntent,
  normalizeProductText,
  tokenizeProductQuery,
  tokensRelated,
} from './productSelection.utils';

const ORDINAL_WORDS: Record<string, number> = {
  primer: 1,
  primero: 1,
  primera: 1,
  '1ro': 1,
  '1ra': 1,
  segundo: 2,
  segunda: 2,
  '2do': 2,
  '2da': 2,
  tercer: 3,
  tercero: 3,
  tercera: 3,
  '3ro': 3,
  '3ra': 3,
  cuarto: 4,
  cuarta: 4,
  quinto: 5,
  quinta: 5,
  sexto: 6,
  sexta: 6,
  septimo: 7,
  septima: 7,
  octavo: 8,
  octava: 8,
  noveno: 9,
  novena: 9,
  decimo: 10,
  decima: 10,
};

const LAST_PATTERN = /\b(?:ultim[oa]|final)\b/;

const QTY_WORD = '(\\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)';

/** «dos del primero» / «2 de la opción 4». */
const QUANTITY_BEFORE_REFERENCE = new RegExp(
  `\\b${QTY_WORD}\\s+(?:de|del|de\\s+la|de\\s+las|de\\s+los)\\b`
);

/** «dos unidades del 3», «3 piezas de la opción 2». */
const QUANTITY_WITH_UNIT = new RegExp(
  `\\b${QTY_WORD}\\s+(?:unidades?|piezas?|pares?|uds?)\\b`
);

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

export interface OptionReference {
  /** Posición en el listado, base 0. */
  index: number;
  quantity: number;
}

function quantityFromCapture(raw: string): number {
  const numeric = Number.parseInt(raw, 10);
  if (Number.isFinite(numeric)) return numeric > 0 && numeric < 100 ? numeric : 1;
  return WORD_QUANTITY[raw] ?? 1;
}

function parseQuantity(normalized: string, originalText: string): number {
  const withUnit = normalized.match(QUANTITY_WITH_UNIT);
  if (withUnit) return quantityFromCapture(withUnit[1]!);

  const beforeRef = normalized.match(QUANTITY_BEFORE_REFERENCE);
  if (beforeRef) return quantityFromCapture(beforeRef[1]!);

  const fromDigits = extractQuantityFromText(originalText, 0);
  return fromDigits > 0 ? fromDigits : 1;
}

/**
 * Los listados se etiquetan con letras (`A)`, `B)`…) porque los nombres de producto ya
 * llevan números (*Balín #6*, tallas). Se aceptan sueltas o precedidas de "la"/"opción".
 */
const LETTER_PATTERN =
  /^(?:(?:de\s+)?(?:la|el)\s+)?(?:opcion|letra)?\s*([a-z])\)?[.!]?$|\b(?:opcion|letra)\s+([a-z])\b/;

/**
 * Un listado donde los propios productos se llaman por número ("Balín #6", "talla 8")
 * hace ambiguo el dígito suelto: el cliente que escribe "6" casi siempre habla del
 * producto, no de la sexta línea. En ese caso solo valen letras, ordinales o el ID.
 */
function optionsUseNumbersInNames(options: Pick<OfferedOption, 'name'>[]): boolean {
  return options.some((option) => /\d/.test(option.name));
}

/**
 * Devuelve la opción a la que apunta el cliente, o `null` si el texto no es una
 * referencia posicional. Nunca inventa posiciones fuera del listado.
 */
export function parseOptionReference(
  text: string,
  optionCount: number,
  options?: Pick<OfferedOption, 'name'>[]
): OptionReference | null {
  if (optionCount <= 0) return null;

  const t = normalizeProductText(text);
  if (!t) return null;

  const quantity = parseQuantity(t, text);

  const letterMatch = t.match(LETTER_PATTERN);
  const letter = letterMatch?.[1] ?? letterMatch?.[2];
  if (letter) {
    const position = letter.charCodeAt(0) - 96;
    if (position >= 1 && position <= optionCount) return { index: position - 1, quantity };
  }

  for (const [word, position] of Object.entries(ORDINAL_WORDS)) {
    if (!new RegExp(`\\b${word}\\b`).test(t)) continue;
    return position <= optionCount ? { index: position - 1, quantity } : null;
  }

  if (LAST_PATTERN.test(t)) return { index: optionCount - 1, quantity };

  if (options && optionsUseNumbersInNames(options)) return null;

  // Solo números que claramente señalan una posición: "el 3", "opción 2", "el número 4"
  // o el mensaje entero siendo un número. Una medida suelta ("45") no cuenta.
  const numericMatch =
    t.match(/^(?:(?:la|el|los|las)\s+)?(?:opcion|numero|num|#)\s*(\d{1,2})$/) ??
    t.match(/^(?:la|el)\s+(\d{1,2})$/) ??
    t.match(/^(\d{1,2})$/) ??
    t.match(/\b(?:opcion|numero|num|#)\s*(\d{1,2})\b/) ??
    t.match(/\b(?:del|de\s+la|de\s+el)\s+(\d{1,2})\b/);

  if (numericMatch) {
    const position = Number.parseInt(numericMatch[1]!, 10);
    if (position >= 1 && position <= optionCount) return { index: position - 1, quantity };
  }

  return null;
}

const OPTION_NAME_NOISE = /^(opciones?|variaciones?|tallas?|medidas?|colores?|tienen|tienes|hay|del|de|la|el|los|las|que|quiero|ver|verlas)$/;

/**
 * El cliente nombra un producto del último listado: "opciones del anillo elefante".
 * Hace falta que el nombre coincida de forma clara; si no, se sigue el flujo normal.
 */
export function matchOfferedOptionByName(text: string, options: OfferedOption[]): OptionReference | null {
  if (!options.length) return null;

  const tokens = tokenizeProductQuery(text).filter((token) => !OPTION_NAME_NOISE.test(token));
  if (!tokens.length) return null;

  const scored = options.map((option, index) => {
    const nameTokens = tokenizeProductQuery(option.name);
    const matched = tokens.filter((token) => nameTokens.some((name) => tokensRelated(name, token))).length;
    return { index, matched, coverage: matched / tokens.length };
  });

  scored.sort((a, b) => b.matched - a.matched || b.coverage - a.coverage);
  const best = scored[0];
  const second = scored[1];
  if (!best || best.matched === 0) return null;
  if (best.coverage < 0.6 && best.matched < 2) return null;
  if (second && second.matched === best.matched && second.coverage === best.coverage) return null;

  return { index: best.index, quantity: parseQuantity(normalizeProductText(text), text) };
}

/**
 * Número de producto en el mensaje (#3, del #3, 4 unidades del 3). No es la posición
 * del listado: en balines «del #3» casi siempre apunta al Balín #3 del último listado.
 */
export function extractListedProductNumber(text: string): string | null {
  const t = normalizeProductText(text);
  if (!t) return null;

  const hash = t.match(/#\s*(\d{1,2})\b/);
  if (hash) return hash[1]!;

  if (!QUANTITY_WITH_UNIT.test(t) && !/\bbalin(?:es)?\b/.test(t)) return null;

  const delNum = t.match(/\bdel?\s+(\d{1,2})\b/);
  return delNum?.[1] ?? null;
}

function indicesMatchingListedProductNumber(num: string, options: OfferedOption[]): number[] {
  const pattern = new RegExp(`#\\s*${num}\\b`, 'i');
  return options
    .map((option, index) => (pattern.test(option.name) ? index : -1))
    .filter((index) => index >= 0);
}

/** Una sola coincidencia de #N en el último listado; si hay varias, devuelve null. */
export function matchOfferedOptionByListedProductNumber(
  text: string,
  options: OfferedOption[]
): OptionReference | null {
  const num = extractListedProductNumber(text);
  if (!num || !options.length) return null;

  const indices = indicesMatchingListedProductNumber(num, options);
  if (indices.length !== 1) return null;

  return {
    index: indices[0]!,
    quantity: parseQuantity(normalizeProductText(text), text),
  };
}

/** Dos o más líneas del listado comparten el mismo #N (p. ej. #5 Liso y #5 Diamantado). */
export function findListedProductNumberAmbiguity(
  text: string,
  options: OfferedOption[]
): number[] | null {
  const num = extractListedProductNumber(text);
  if (!num || !options.length) return null;

  const indices = indicesMatchingListedProductNumber(num, options);
  return indices.length >= 2 ? indices : null;
}

/**
 * Número o nombre sobre el último listado. Prioriza el ID, luego el #N del listado,
 * luego la posición ("del 5") y por último el nombre.
 */
export function findOfferedOption(text: string, options: OfferedOption[]): OptionReference | null {
  if (!options.length) return null;

  const bySku = matchOfferedOptionBySku(text, options);
  if (bySku) return bySku;

  const byListedNumber = matchOfferedOptionByListedProductNumber(text, options);
  if (byListedNumber) return byListedNumber;

  const byPosition = parseOptionReference(text, options.length, options);
  if (byPosition) return byPosition;

  if (isProductOptionsBrowseIntent(text) || tokenizeProductQuery(text).length >= 2) {
    return matchOfferedOptionByName(text, options);
  }

  return null;
}

/** El cliente reenvía el *ID* que vio en la lista, a veces con la negrita de WhatsApp. */
export function matchOfferedOptionBySku(text: string, options: OfferedOption[]): OptionReference | null {
  const tokens = new Set(tokenizeProductQuery(text));
  if (!tokens.size) return null;

  const index = options.findIndex((option) => {
    const sku = option.sku?.trim();
    return Boolean(sku) && tokens.has(normalizeProductText(sku!));
  });

  if (index < 0) return null;
  return { index, quantity: parseQuantity(normalizeProductText(text), text) };
}
