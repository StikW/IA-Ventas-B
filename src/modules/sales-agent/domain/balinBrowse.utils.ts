/**
 * Listado de balines en dos pasos.
 *
 * En WooCommerce cada tamaño es un producto simple (`Balín #3 Diamantado Oro Nacional
 * Amarillo`). Las categorías no sirven para agrupar: varios lisos están marcados como
 * Diamantado y algún rosa como Oro Amarillo. El tipo sale del nombre, quitando el `#N`.
 *
 * Pregunta general → tipos (acabado + oro). Elegir un tipo → sus tamaños.
 * Pregunta con `#N` → todos los de ese número, de cualquier tipo.
 */

import { WooCommerceProduct } from '../../woocommerce/domain/IWooCommerceService';
import { OfferedOption } from './IChatSessionRepository';
import { catalogQueryTokens } from './catalogMatch.utils';
import { optionLabel, toOfferedOptionFromProduct } from './productDisplay.utils';
import { normalizeProductText, tokenizeProductQuery, tokensRelated } from './productSelection.utils';
import { EMOJI, warmOptionsOpener } from './tone.utils';

export interface BalinTypeGroup {
  key: string;
  label: string;
  products: WooCommerceProduct[];
}

export type BalinBrowsePlan =
  | { kind: 'types'; message: string; options: OfferedOption[] }
  | { kind: 'sizes'; label: string; products: WooCommerceProduct[] }
  | { kind: 'default' };

const BALIN_NAME = /^bal[ií]n\s+#\s*(\d+)\s+(.+)$/i;

export function isBalinFamilyTerm(term: string): boolean {
  const normalized = normalizeProductText(term).replace(/es$/, '').replace(/s$/, '');
  return tokensRelated(normalized, 'balin') || normalized === 'bolita';
}

/** `#6` en la pregunta. Una cantidad ("18 balines") no es un tamaño. */
export function extractBalinSizeQuery(text: string): string | null {
  const match = normalizeProductText(text).match(/#\s*(\d+)\b/);
  return match?.[1] ?? null;
}

export function balinTypeFromName(name: string): { size: string; label: string } | null {
  const cleaned = name.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  const match = cleaned.match(BALIN_NAME);
  if (!match?.[1] || !match[2]) return null;
  const rest = match[2].replace(/\s+/g, ' ').trim();
  if (!rest) return null;
  return { size: match[1], label: `Balín ${rest}` };
}

function sizeNumber(name: string): number {
  const parsed = balinTypeFromName(name);
  return parsed ? Number.parseInt(parsed.size, 10) : 999;
}

function typeSortKey(label: string): string {
  const normalized = normalizeProductText(label);
  const metal = normalized.includes('amarill') ? '0' : normalized.includes('rosa') ? '1' : '2';
  const finish = normalized.includes('diamant') ? '0' : normalized.includes('liso') ? '1' : '2';
  return `${metal}-${finish}-${normalized}`;
}

export function sortBalinProducts(products: WooCommerceProduct[]): WooCommerceProduct[] {
  return [...products].sort(
    (a, b) => sizeNumber(a.name) - sizeNumber(b.name) || a.name.localeCompare(b.name, 'es')
  );
}

export function groupBalinProducts(products: WooCommerceProduct[]): {
  groups: BalinTypeGroup[];
  loose: WooCommerceProduct[];
} {
  const map = new Map<string, BalinTypeGroup>();
  const loose: WooCommerceProduct[] = [];

  for (const product of products) {
    const parsed = balinTypeFromName(product.name);
    if (!parsed) {
      loose.push(product);
      continue;
    }

    const key = normalizeProductText(parsed.label);
    const existing = map.get(key);
    if (existing) existing.products.push(product);
    else map.set(key, { key, label: parsed.label, products: [product] });
  }

  const groups = [...map.values()]
    .map((group) => ({ ...group, products: sortBalinProducts(group.products) }))
    .sort((a, b) => typeSortKey(a.label).localeCompare(typeSortKey(b.label), 'es'));

  return { groups, loose };
}

function narrowGroups(groups: BalinTypeGroup[], userText: string): BalinTypeGroup[] {
  const tokens = catalogQueryTokens(userText).filter(
    (token) => !tokensRelated(token, 'balin') && !/^#?\d+$/.test(token)
  );
  if (!tokens.length) return groups;

  const matched = groups.filter((group) => {
    const nameTokens = tokenizeProductQuery(group.label);
    return tokens.every((token) => nameTokens.some((name) => tokensRelated(name, token)));
  });

  return matched.length ? matched : groups;
}

function typeOption(group: BalinTypeGroup): OfferedOption {
  const first = group.products[0]!;
  if (group.products.length === 1) return toOfferedOptionFromProduct(first);

  return {
    productId: first.id,
    name: group.label,
    memberProductIds: group.products.map((product) => product.id),
  };
}

export function buildBalinTypeListMessage(lines: string[]): string {
  const count = lines.length;
  const opener = warmOptionsOpener('balines');
  const intro = `${opener} Tenemos ${count} ${count === 1 ? 'tipo' : 'tipos'} de *balines* ${EMOJI.gem}`;

  return [
    intro,
    '',
    ...lines,
    '',
    `Dime la *letra* del tipo que te guste y te muestro sus tamaños ${EMOJI.sparkle}`,
  ].join('\n');
}

/**
 * Solo cambia el listado de la familia balín. El resto de familias sigue el camino de siempre.
 */
export function planBalinFamilyBrowse(
  products: WooCommerceProduct[],
  userText: string,
  familyTerm: string
): BalinBrowsePlan {
  if (!isBalinFamilyTerm(familyTerm) || products.length < 2) return { kind: 'default' };

  const { groups, loose } = groupBalinProducts(products);
  if (groups.length < 1 || groups.reduce((sum, group) => sum + group.products.length, 0) < 2) {
    return { kind: 'default' };
  }

  const size = extractBalinSizeQuery(userText);
  if (size) {
    const sized = sortBalinProducts(
      groups.flatMap((group) => group.products).filter((product) => balinTypeFromName(product.name)?.size === size)
    );
    if (!sized.length) return { kind: 'default' };
    return { kind: 'sizes', label: `Balín #${size}`, products: sized };
  }

  const narrowed = narrowGroups(groups, userText);
  const showsEveryType =
    narrowed.length === groups.length &&
    narrowed.every((group, index) => group.key === groups[index]?.key);

  if (narrowed.length === 1) {
    const only = narrowed[0]!;
    return { kind: 'sizes', label: only.label, products: only.products };
  }

  const lines: string[] = [];
  const options: OfferedOption[] = [];

  narrowed.forEach((group, index) => {
    lines.push(`${optionLabel(index + 1)}) ${group.label}`);
    options.push(typeOption(group));
  });

  if (showsEveryType) {
    for (const product of loose) {
      lines.push(`${optionLabel(lines.length + 1)}) ${product.name.trim()}`);
      options.push(toOfferedOptionFromProduct(product));
    }
  }

  if (lines.length < 2) return { kind: 'default' };

  return { kind: 'types', message: buildBalinTypeListMessage(lines), options };
}
