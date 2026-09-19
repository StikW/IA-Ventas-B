/**
 * Arma el `.txt` de catálogo que el agente usa para traducir lenguaje natural a SKU.
 * El stock y el precio siempre salen de WooCommerce en vivo; este documento solo
 * declara Producto / SKU / Variaciones / Paquetes.
 */

import { parsePackTiersFromMeta, type PackTier } from '../../../sales-agent/domain/packPricing.utils';
import type {
  CatalogTxtProduct,
  CatalogTxtSourceEntry,
  CatalogTxtVariation,
} from '../../../woocommerce/domain/IWooCommerceService';

export type { CatalogTxtProduct, CatalogTxtSourceEntry, CatalogTxtVariation };

export interface CatalogTxtIssue {
  kind: string;
  detail: string;
}

export interface CatalogTxtStats {
  productCount: number;
  skuCount: number;
  packCount: number;
}

export interface CatalogTxtResult {
  text: string;
  stats: CatalogTxtStats;
  issues: CatalogTxtIssue[];
}

export function cleanCatalogText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMillimeters(product: CatalogTxtProduct, variations: CatalogTxtVariation[]): string | null {
  const sources = [
    product.name,
    ...product.attributes.flatMap((attribute) => attribute.options),
    ...variations.flatMap((variation) => variation.attributes.map((a) => a.option)),
  ];

  for (const source of sources) {
    const match = source.match(/(\d+(?:[.,]\d+)?)\s*(?:mm|x|×)/i);
    if (match) return match[1]!.replace(',', '.');
  }
  return null;
}

function buildSeoKeywords(product: CatalogTxtProduct): string {
  const words = new Set<string>();
  for (const token of cleanCatalogText(product.name).toLowerCase().split(/\s+/)) {
    if (token.length > 2) words.add(token);
  }
  for (const category of product.categories) {
    for (const token of category.name.toLowerCase().split(/\s+/)) {
      if (token.length > 2) words.add(token);
    }
  }
  return [...words].join(' ');
}

function extractPackPresentation(
  product: CatalogTxtProduct
): { line: string; tiers: PackTier[] } | null {
  const tiers = parsePackTiersFromMeta(product.meta_data);
  if (!tiers) return null;

  const metaValue = (key: string): string | null => {
    const raw = product.meta_data.find((meta) => meta.key === key)?.value;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  };

  const plural = metaValue('_wm_promo_unit_plural') ?? `${metaValue('_wm_promo_unit_label') ?? 'unidad'}es`;
  const units = [...tiers].sort((a, b) => a.units - b.units).map((tier) => tier.units);

  return { line: `Paquetes: ${units.join(', ')} ${plural}`, tiers };
}

function variationLabel(variation: CatalogTxtVariation): string {
  const label = variation.attributes.map((attribute) => attribute.option).join(' ').trim();
  return label || variation.sku || String(variation.id);
}

function buildBlock(
  product: CatalogTxtProduct,
  variations: CatalogTxtVariation[],
  issues: CatalogTxtIssue[]
): { text: string; skus: string[] } | null {
  const name = cleanCatalogText(product.name).replace(/^[:\s-]+/, '');
  if (!name) {
    issues.push({ kind: 'Producto sin nombre', detail: `id=${product.id}` });
    return null;
  }
  if (name !== cleanCatalogText(product.name)) {
    issues.push({
      kind: 'Nombre con caracteres iniciales sobrantes',
      detail: `id=${product.id} "${cleanCatalogText(product.name)}"`,
    });
  }

  const lines: string[] = [`Producto: ${name}`];

  const sellable = variations.length
    ? variations.filter((variation) => variation.sku?.trim())
    : product.sku?.trim()
      ? [
          {
            id: product.id,
            sku: product.sku.trim(),
            price: product.price,
            stock_status: product.stock_status,
            attributes: [],
          },
        ]
      : [];

  if (!sellable.length) {
    issues.push({
      kind: 'Sin SKU: el agente no puede venderlo',
      detail: `id=${product.id} "${name}"${variations.length ? ` (${variations.length} variaciones)` : ''}`,
    });
    return null;
  }

  if (variations.length && sellable.length < variations.length) {
    issues.push({
      kind: 'Variaciones sin SKU',
      detail: `id=${product.id} "${name}" (${variations.length - sellable.length} de ${variations.length})`,
    });
  }

  lines.push(`SKU: ${sellable.map((item) => item.sku).join('\n')}`);

  if (product.categories.length) {
    lines.push(`Categoría: ${product.categories.map((category) => category.name).join(', ')}`);
  } else {
    issues.push({ kind: 'Sin categoría', detail: `id=${product.id} "${name}"` });
  }

  if (product.tags.length) {
    lines.push(`Etiquetas: ${product.tags.map((tag) => tag.name).join(', ')}`);
  }

  const millimeters = extractMillimeters(product, variations);
  if (millimeters) lines.push(`Milímetros: ${millimeters}`);

  if (variations.length) {
    lines.push(`Variaciones: ${sellable.map((item) => variationLabel(item)).join('|')}`);
  }

  const packs = extractPackPresentation(product);
  if (packs) {
    lines.push(packs.line);
    if (variations.length) {
      issues.push({
        kind: 'Producto variable con paquetes woo-massi',
        detail: `id=${product.id} "${name}" (el agente no combina paquetes en productos variables)`,
      });
    }
  }

  const description = cleanCatalogText(product.short_description);
  if (description) lines.push(`Descripción corta: ${description.slice(0, 400)}`);

  lines.push(`Palabra Clave SEO: ${buildSeoKeywords(product)}`);
  lines.push('ESTADO: Listo');

  return { text: lines.join('\n'), skus: sellable.map((item) => item.sku) };
}

export function collectCatalogDataIssues(
  products: CatalogTxtProduct[],
  issues: CatalogTxtIssue[]
): CatalogTxtIssue[] {
  const byName = new Map<string, number[]>();
  for (const product of products) {
    const key = cleanCatalogText(product.name).toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), product.id]);
  }
  for (const [name, ids] of byName) {
    if (ids.length > 1) {
      issues.push({ kind: 'Nombre duplicado', detail: `"${name}" → ids ${ids.join(', ')}` });
    }
  }

  const attributeNames = new Map<string, number>();
  for (const product of products) {
    for (const attribute of product.attributes) {
      attributeNames.set(attribute.name, (attributeNames.get(attribute.name) ?? 0) + 1);
    }
  }

  const sizeLike = [...attributeNames.keys()].filter((name) =>
    /tama|talla|size|medida|largo/i.test(name)
  );
  if (sizeLike.length > 1) {
    issues.push({
      kind: 'Atributos de talla con nombres distintos',
      detail: sizeLike.map((name) => `"${name}" (${attributeNames.get(name)})`).join(', '),
    });
  }

  return issues;
}

export function formatCatalogIssuesReport(issues: CatalogTxtIssue[]): string {
  const grouped = new Map<string, string[]>();
  for (const issue of issues) {
    grouped.set(issue.kind, [...(grouped.get(issue.kind) ?? []), issue.detail]);
  }

  if (!grouped.size) {
    return 'Sin inconsistencias detectadas en el catálogo.';
  }

  const lines = ['Inconsistencias detectadas (revisar en WooCommerce):'];
  for (const [kind, details] of grouped) {
    lines.push(`\n• ${kind} (${details.length}):`);
    for (const detail of details.slice(0, 20)) lines.push(`    - ${detail}`);
    if (details.length > 20) lines.push(`    … y ${details.length - 20} más`);
  }
  return lines.join('\n');
}

export function summarizeCatalogIssues(
  issues: CatalogTxtIssue[]
): Array<{ kind: string; count: number }> {
  const grouped = new Map<string, number>();
  for (const issue of issues) {
    grouped.set(issue.kind, (grouped.get(issue.kind) ?? 0) + 1);
  }
  return [...grouped.entries()].map(([kind, count]) => ({ kind, count }));
}

export function buildCatalogTxt(
  entries: CatalogTxtSourceEntry[],
  options?: { generatedAt?: Date }
): CatalogTxtResult {
  const issues: CatalogTxtIssue[] = [];
  const blocks: string[] = [];
  let skuCount = 0;

  for (const { product, variations } of entries) {
    const block = buildBlock(product, variations, issues);
    if (block) {
      blocks.push(block.text);
      skuCount += block.skus.length;
    }
  }

  collectCatalogDataIssues(
    entries.map((entry) => entry.product),
    issues
  );

  const generatedAt = (options?.generatedAt ?? new Date()).toISOString().slice(0, 10);
  const header = [
    '# Catálogo de productos',
    `# Generado desde WooCommerce el ${generatedAt}`,
    '# El stock y el precio se consultan en WooCommerce en tiempo real.',
    '# "Paquetes" indica que el producto se vende a granel: el agente combina los paquetes',
    '# más baratos que sumen la cantidad pedida y cotiza con los precios vivos de WooCommerce.',
  ].join('\n');

  const text = blocks.length ? `${header}\n\n---\n${blocks.join('\n\n---\n')}\n` : `${header}\n`;
  const packCount = blocks.filter((block) => /^Paquetes: /m.test(block)).length;

  return {
    text,
    stats: {
      productCount: blocks.length,
      skuCount,
      packCount,
    },
    issues,
  };
}
