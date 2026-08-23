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
 * Devuelve la opción a la que apunta el cliente, o `null` si el texto no es una
 * referencia posicional. Nunca inventa posiciones fuera del listado.
 */
export function parseOptionReference(text: string, optionCount: number): OptionReference | null {
  if (optionCount <= 0) return null;

  const t = normalizeProductText(text);
  if (!t) return null;

  const quantity = parseQuantity(t, text);

  for (const [word, position] of Object.entries(ORDINAL_WORDS)) {
    if (!new RegExp(`\\b${word}\\b`).test(t)) continue;
    return position <= optionCount ? { index: position - 1, quantity } : null;
  }

  if (LAST_PATTERN.test(t)) return { index: optionCount - 1, quantity };

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
 * Número o nombre sobre el último listado. Prioriza la posición ("del 5") para no
 * confundir "el 5" con una talla.
 */
export function findOfferedOption(text: string, options: OfferedOption[]): OptionReference | null {
  if (!options.length) return null;

  const byPosition = parseOptionReference(text, options.length);
  if (byPosition) return byPosition;

  if (isProductOptionsBrowseIntent(text) || tokenizeProductQuery(text).length >= 2) {
    return matchOfferedOptionByName(text, options);
  }

  return null;
}
