/**
 * Genera el `.txt` de catálogo que el negocio sube al panel para vectorizar (RAG).
 *
 * El agente usa ese documento para traducir lenguaje natural a SKU; el stock y el precio
 * siempre salen de WooCommerce en vivo. El formato de bloques que produce este script es el
 * que espera `catalogRag.utils.ts`: campos `Producto:` / `SKU:` / `Variaciones:` separados
 * por `---`, con los SKU y las variaciones en el mismo orden.
 *
 * Los productos a granel (balines, canutillos) son *simples* con un solo SKU: las
 * presentaciones x1/x2/x5/x10 viven en meta de `woo-massi` y se emiten como `Paquetes:`.
 *
 * Uso:
 *   npx tsx scripts/generate-catalog-txt.ts --out catalogo.txt
 *   npx tsx scripts/generate-catalog-txt.ts \
 *     --store https://mitienda.com --key ck_xxx --secret cs_xxx --out catalogo.txt
 *
 * Sin `--store/--key/--secret` usa WC_STORE_URL, WC_CONSUMER_KEY y WC_CONSUMER_SECRET, y como
 * último recurso las credenciales que el negocio guardó en el panel (`--tenant <id>`).
 */

import { writeFile } from 'node:fs/promises';

import {
  parsePackTiersFromMeta,
  type PackTier,
} from '../src/modules/sales-agent/domain/packPricing.utils';
import { readFlag, resolveWcCredentials, wcGet, type WcCredentials } from './wc-credentials';

interface WcTerm {
  id: number;
  name: string;
}

interface WcMeta {
  key: string;
  value: unknown;
}

interface WcProduct {
  id: number;
  name: string;
  sku: string;
  type: string;
  status: string;
  price: string;
  short_description: string;
  stock_status: string;
  categories: WcTerm[];
  tags: WcTerm[];
  attributes: Array<{ name: string; options: string[] }>;
  meta_data: WcMeta[];
}

interface WcVariation {
  id: number;
  sku: string;
  price: string;
  stock_status: string;
  attributes: Array<{ name: string; option: string }>;
}

interface Issue {
  kind: string;
  detail: string;
}

async function fetchAllProducts(base: WcCredentials): Promise<WcProduct[]> {
  const all: WcProduct[] = [];
  for (let page = 1; ; page++) {
    const batch = await wcGet<WcProduct[]>(
      base,
      `/products?per_page=100&page=${page}&status=publish&orderby=id&order=asc`
    );
    all.push(...batch);
    process.stderr.write(`\rProductos leídos: ${all.length}`);
    if (batch.length < 100) break;
  }
  process.stderr.write('\n');
  return all;
}

function cleanText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Medida en milímetros del nombre o de los atributos, que el agente usa para desambiguar. */
function extractMillimeters(product: WcProduct, variations: WcVariation[]): string | null {
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

/** Términos por los que el cliente puede pedir el producto, para mejorar el RAG. */
function buildSeoKeywords(product: WcProduct): string {
  const words = new Set<string>();
  for (const token of cleanText(product.name).toLowerCase().split(/\s+/)) {
    if (token.length > 2) words.add(token);
  }
  for (const category of product.categories) {
    for (const token of category.name.toLowerCase().split(/\s+/)) {
      if (token.length > 2) words.add(token);
    }
  }
  return [...words].join(' ');
}

/**
 * Presentaciones a granel del plugin `woo-massi`: el producto es simple (un SKU) y los
 * paquetes x1/x2/x5/x10 viven en meta, no como variaciones. El `.txt` solo declara las
 * presentaciones; los precios de cada paquete los lee el agente de WooCommerce en vivo.
 */
function extractPackPresentation(product: WcProduct): { line: string; tiers: PackTier[] } | null {
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

function variationLabel(variation: WcVariation): string {
  const label = variation.attributes.map((attribute) => attribute.option).join(' ').trim();
  return label || variation.sku || String(variation.id);
}

interface Block {
  text: string;
  skus: string[];
}

function buildBlock(product: WcProduct, variations: WcVariation[], issues: Issue[]): Block | null {
  const name = cleanText(product.name).replace(/^[:\s-]+/, '');
  if (!name) {
    issues.push({ kind: 'Producto sin nombre', detail: `id=${product.id}` });
    return null;
  }
  if (name !== cleanText(product.name)) {
    issues.push({
      kind: 'Nombre con caracteres iniciales sobrantes',
      detail: `id=${product.id} "${cleanText(product.name)}"`,
    });
  }

  const lines: string[] = [`Producto: ${name}`];

  const sellable = variations.length
    ? variations.filter((variation) => variation.sku?.trim())
    : product.sku?.trim()
      ? [{ id: product.id, sku: product.sku.trim(), price: product.price, stock_status: product.stock_status, attributes: [] }]
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
    lines.push(`Variaciones: ${sellable.map((item) => variationLabel(item as WcVariation)).join('|')}`);
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

  const description = cleanText(product.short_description);
  if (description) lines.push(`Descripción corta: ${description.slice(0, 400)}`);

  lines.push(`Palabra Clave SEO: ${buildSeoKeywords(product)}`);
  lines.push('ESTADO: Listo');

  return { text: lines.join('\n'), skus: sellable.map((item) => item.sku) };
}

function reportDataIssues(products: WcProduct[], issues: Issue[]): void {
  const byName = new Map<string, number[]>();
  for (const product of products) {
    const key = cleanText(product.name).toLowerCase();
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

  const grouped = new Map<string, string[]>();
  for (const issue of issues) {
    grouped.set(issue.kind, [...(grouped.get(issue.kind) ?? []), issue.detail]);
  }

  if (!grouped.size) {
    console.error('\nSin inconsistencias detectadas en el catálogo.');
    return;
  }

  console.error('\nInconsistencias detectadas (revisar en WooCommerce):');
  for (const [kind, details] of grouped) {
    console.error(`\n• ${kind} (${details.length}):`);
    for (const detail of details.slice(0, 20)) console.error(`    - ${detail}`);
    if (details.length > 20) console.error(`    … y ${details.length - 20} más`);
  }
}

async function main(): Promise<void> {
  const out = readFlag('--out') ?? 'catalogo.txt';
  const base = await resolveWcCredentials();
  console.error(`Tienda: ${base.storeUrl} (credenciales: ${base.source})`);

  const products = await fetchAllProducts(base);
  const issues: Issue[] = [];
  const blocks: string[] = [];
  let skuCount = 0;

  for (const [index, product] of products.entries()) {
    const variations =
      product.type === 'variable'
        ? await wcGet<WcVariation[]>(base, `/products/${product.id}/variations?per_page=100`)
        : [];

    const block = buildBlock(product, variations, issues);
    if (block) {
      blocks.push(block.text);
      skuCount += block.skus.length;
    }
    process.stderr.write(`\rBloques generados: ${blocks.length}/${index + 1}`);
  }
  process.stderr.write('\n');

  const header = [
    '# Catálogo de productos',
    `# Generado desde WooCommerce el ${new Date().toISOString().slice(0, 10)}`,
    '# El stock y el precio se consultan en WooCommerce en tiempo real.',
    '# "Paquetes" indica que el producto se vende a granel: el agente combina los paquetes',
    '# más baratos que sumen la cantidad pedida y cotiza con los precios vivos de WooCommerce.',
  ].join('\n');

  await writeFile(out, `${header}\n\n---\n${blocks.join('\n\n---\n')}\n`, 'utf8');

  const packCount = blocks.filter((block) => /^Paquetes: /m.test(block)).length;

  console.error(
    `\n${out}: ${blocks.length} productos, ${skuCount} SKU vendibles, ${packCount} a granel.`
  );
  reportDataIssues(products, issues);
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
