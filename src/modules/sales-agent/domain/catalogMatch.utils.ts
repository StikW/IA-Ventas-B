/**
 * Matching local del catálogo WooCommerce.
 *
 * El parámetro `search` de la API de WooCommerce es un `LIKE '%frase%'` literal: no separa
 * palabras ni tolera plurales, así que "dijes" o "dije virgen carmen" devuelven 0 resultados
 * aunque el producto exista. Estas utilidades puntúan el catálogo completo en memoria por
 * tokens, que es lo que permite resolver lenguaje natural sobre catálogos grandes.
 */

import { WooCommerceProduct } from '../../woocommerce/domain/IWooCommerceService';
import {
  normalizeProductText,
  tokenizeProductQuery,
  tokensRelated,
  variantHintsMatch,
} from './productSelection.utils';

/** Diferencia de puntaje a partir de la cual el primer candidato se considera ganador claro. */
export const CATALOG_MATCH_DECISIVE_GAP = 5;

/** Puntaje mínimo para tomar un producto como candidato real. */
export const CATALOG_MATCH_MIN_SCORE = 6;

/**
 * Sinónimos que usa el cliente frente al nombre real en la tienda.
 * Se consultan solo si el término literal no existe en el catálogo.
 */
const FAMILY_SYNONYMS: Record<string, string[]> = {
  arete: ['topo', 'candonga', 'zarcillo'],
  aretes: ['topo', 'candonga', 'zarcillo'],
  topito: ['topo'],
  topitos: ['topo'],
  candonga: ['topo', 'arete'],
  candongas: ['topo', 'arete'],
  zarcillo: ['topo', 'arete'],
  zarcillos: ['topo', 'arete'],
  colgante: ['dije'],
  colgantes: ['dije'],
  pendiente: ['dije', 'topo'],
  pendientes: ['dije', 'topo'],
  medallita: ['medalla', 'dije'],
  medallitas: ['medalla', 'dije'],
  collar: ['cadena'],
  collares: ['cadena'],
  gargantilla: ['cadena'],
  gargantillas: ['cadena'],
  sortija: ['anillo'],
  sortijas: ['anillo'],
  argolla: ['anillo'],
  argollas: ['anillo'],
  esclava: ['pulsera', 'cadena'],
  esclavas: ['pulsera', 'cadena'],
  manilla: ['pulsera', 'cadena'],
  manillas: ['pulsera', 'cadena'],
  bolita: ['balin'],
  bolitas: ['balin'],
  broche: ['herraje'],
  broches: ['herraje'],
  cierre: ['herraje'],
  cierres: ['herraje'],
};

export interface CatalogEntry {
  product: WooCommerceProduct;
  nameTokens: string[];
  categoryTokens: string[];
  tagTokens: string[];
  descriptionTokens: string[];
  /** Tokens por los que se puede pedir el tipo de producto (nombre + categorías). */
  familyTokens: string[];
  /**
   * Primera palabra del nombre. En un catálogo de comercio es el tipo de producto
   * ("Dije Virgen…", "Herraje San Benito"), a diferencia de las categorías, que mezclan
   * tipo con material y motivo ("Oro Nacional", "Religioso").
   */
  primaryFamilyToken?: string;
}

export interface CatalogMatch {
  entry: CatalogEntry;
  score: number;
  matchedTokens: number;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, ' ');
}

function includesToken(tokens: string[], token: string): boolean {
  return tokens.some((candidate) => tokensRelated(candidate, token));
}

/**
 * Muchos nombres del catálogo vienen con guiones ("Balín-Diamantado-#6-Oro amarillo").
 * Sin separarlos, "diamantado" no coincidiría con nada.
 */
function catalogTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const token of tokenizeProductQuery(text)) {
    tokens.push(token);
    if (/[-/]/.test(token)) {
      for (const part of token.split(/[-/]+/)) {
        if (part.length > 1) tokens.push(part.replace(/^#/, ''));
      }
    }
  }
  return [...new Set(tokens)];
}

export function buildCatalogEntry(product: WooCommerceProduct): CatalogEntry {
  const nameTokens = catalogTokens(product.name);
  const categoryTokens = (product.categories ?? []).flatMap((category) =>
    catalogTokens(category.name)
  );
  const tagTokens = (product.tags ?? []).flatMap((tag) => catalogTokens(tag));
  const descriptionTokens = catalogTokens(stripHtml(product.description ?? '')).slice(0, 40);

  const familyTokens = [...new Set([...nameTokens.slice(0, 3), ...categoryTokens])];
  const primaryFamilyToken = nameTokens.find((token) => !/[-/#\d]/.test(token));

  return {
    product,
    nameTokens,
    categoryTokens,
    tagTokens,
    descriptionTokens,
    familyTokens,
    primaryFamilyToken,
  };
}

/**
 * Palabras de la pregunta, no del producto: "qué opciones tienes del anillo…" no debe
 * puntuar "opciones" ni "tienes" contra el catálogo.
 */
const CATALOG_QUERY_NOISE =
  /^(opciones?|variaciones?|tallas?|medidas?|colores?|tienen|tienes|tiene|hay|muestra|mostrar|muestrame|listar|ver|alguna|alguno|algunas|algunos|forma|formas|joya|joyas|busco|buscan|disponible|disponibles|quiero|quisiera|gustaria|interes[oa]|me|mi|tu|su|este|esta|eso|esa|cual|cuales|que)$/;

/** Tokens útiles del mensaje del cliente, sin medidas ni palabras de la pregunta. */
export function catalogQueryTokens(text: string): string[] {
  return [...new Set(catalogTokens(text).filter((token) => !/^\d+$/.test(token) && !CATALOG_QUERY_NOISE.test(token)))];
}

/**
 * Puntúa un producto contra los tokens del cliente. Cada token aporta una sola vez
 * (el mejor campo donde aparece) para que un nombre largo no infle el puntaje.
 */
export function scoreCatalogEntry(
  entry: CatalogEntry,
  queryTokens: string[],
  variantHint?: string
): CatalogMatch {
  if (!queryTokens.length) return { entry, score: 0, matchedTokens: 0 };

  let score = 0;
  let matchedTokens = 0;

  for (const token of queryTokens) {
    let tokenScore = 0;
    if (entry.nameTokens.includes(token)) tokenScore = 4;
    else if (includesToken(entry.nameTokens, token)) tokenScore = 3;
    else if (includesToken(entry.categoryTokens, token)) tokenScore = 2;
    else if (includesToken(entry.tagTokens, token)) tokenScore = 1;
    else if (includesToken(entry.descriptionTokens, token)) tokenScore = 1;

    if (tokenScore > 0) matchedTokens++;
    score += tokenScore;
  }

  if (!matchedTokens) return { entry, score: 0, matchedTokens: 0 };

  const coverage = matchedTokens / queryTokens.length;
  if (coverage === 1 && queryTokens.length >= 2) score += 6;
  else if (coverage >= 0.6) score += 3;

  // El cliente nombró el producto completo: señal fuerte frente a nombres más largos
  // que solo comparten algunas palabras.
  const nameFullyCovered =
    entry.nameTokens.length > 0 &&
    entry.nameTokens.every((token) => includesToken(queryTokens, token));
  if (nameFullyCovered) score += 6;

  // Una medida exacta es lo que distingue variantes hermanas ("4 mm" frente a "8 mm").
  if (variantHint) {
    const blob = normalizeProductText(entry.product.name);
    if (variantHintsMatch(blob, variantHint)) score += 8;
  }

  if (entry.product.stockStatus !== 'instock') score -= 2;

  return { entry, score, matchedTokens };
}

/** Candidatos ordenados por relevancia. El primero solo es fiable si `isDecisiveMatch`. */
export function rankCatalogEntries(
  entries: CatalogEntry[],
  queryTokens: string[],
  variantHint?: string,
  limit = 10
): CatalogMatch[] {
  return entries
    .map((entry) => scoreCatalogEntry(entry, queryTokens, variantHint))
    .filter((match) => match.score >= CATALOG_MATCH_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.entry.product.name.localeCompare(b.entry.product.name))
    .slice(0, limit);
}

/** Un único candidato, o el primero con ventaja clara sobre el segundo. */
export function isDecisiveMatch(matches: CatalogMatch[]): boolean {
  if (!matches.length) return false;
  if (matches.length === 1) return true;
  return matches[0]!.score - matches[1]!.score >= CATALOG_MATCH_DECISIVE_GAP;
}

/**
 * Tipos de producto del catálogo, para que el agente reconozca consultas como "tienen
 * herrajes". Solo la primera palabra del nombre y con un mínimo de productos: usar las
 * categorías metería materiales y motivos ("amarillo", "religioso") como si fueran tipos.
 */
export function collectFamilyTerms(entries: CatalogEntry[], minProducts = 3): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const token = entry.primaryFamilyToken;
    if (!token || token.length < 4) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minProducts)
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token);
}

/**
 * Productos de una familia ("dijes", "aretes"). Prueba el término literal y, si no
 * aparece en el catálogo, sus sinónimos.
 */
export function findFamilyEntries(
  entries: CatalogEntry[],
  term: string
): { matched: CatalogEntry[]; resolvedTerm: string } {
  const normalized = normalizeProductText(term).trim();
  if (!normalized) return { matched: [], resolvedTerm: term };

  const candidates = [normalized, ...(FAMILY_SYNONYMS[normalized] ?? [])];

  for (const candidate of candidates) {
    const matched = entries.filter((entry) => includesToken(entry.familyTokens, candidate));
    if (matched.length) return { matched, resolvedTerm: candidate };
  }

  return { matched: [], resolvedTerm: normalized };
}

/** Familias reconocidas para un término del cliente, incluidos sinónimos. */
export function expandFamilySynonyms(term: string): string[] {
  const normalized = normalizeProductText(term).trim();
  return [normalized, ...(FAMILY_SYNONYMS[normalized] ?? [])];
}
