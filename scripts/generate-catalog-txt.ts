/**
 * Genera el `.txt` de catálogo que el negocio sube al panel para vectorizar (RAG).
 *
 * El agente usa ese documento para traducir lenguaje natural a SKU; el stock y el precio
 * siempre salen de WooCommerce en vivo. El formato de bloques que produce este script es el
 * que espera `catalogRag.utils.ts`: campos `Producto:` / `SKU:` / `Variaciones:` separados
 * por `---`, con los SKU y las variaciones en el mismo orden.
 *
 * Uso:
 *   npx tsx scripts/generate-catalog-txt.ts \
 *     --store https://mitienda.com --key ck_xxx --secret cs_xxx --out catalogo.txt
 *
 * También lee WC_STORE_URL, WC_CONSUMER_KEY y WC_CONSUMER_SECRET del entorno.
 */

import { writeFile } from 'node:fs/promises';

interface WcTerm {
  id: number;
  name: string;
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

function parseArgs(): { storeUrl: string; key: string; secret: string; out: string } {
  const args = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const storeUrl = (read('--store') ?? process.env.WC_STORE_URL ?? '').replace(/\/$/, '');
  const key = read('--key') ?? process.env.WC_CONSUMER_KEY ?? '';
  const secret = read('--secret') ?? process.env.WC_CONSUMER_SECRET ?? '';
  const out = read('--out') ?? 'catalogo.txt';

  if (!storeUrl || !key || !secret) {
    console.error(
      'Faltan credenciales. Usa --store <url> --key <ck_...> --secret <cs_...> ' +
        'o define WC_STORE_URL, WC_CONSUMER_KEY y WC_CONSUMER_SECRET.'
    );
    process.exit(1);
  }

  return { storeUrl, key, secret, out };
}

async function wcGet<T>(
  base: { storeUrl: string; key: string; secret: string },
  path: string
): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const url =
    `${base.storeUrl}/wp-json/wc/v3${path}${separator}` +
    `consumer_key=${encodeURIComponent(base.key)}&consumer_secret=${encodeURIComponent(base.secret)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`WooCommerce ${response.status} en ${path}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function fetchAllProducts(base: {
  storeUrl: string;
  key: string;
  secret: string;
}): Promise<WcProduct[]> {
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

function variationLabel(variation: WcVariation): string {
  const label = variation.attributes.map((attribute) => attribute.option).join(' ').trim();
  return label || variation.sku || String(variation.id);
}

function buildBlock(product: WcProduct, variations: WcVariation[], issues: Issue[]): string | null {
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

  const description = cleanText(product.short_description);
  if (description) lines.push(`Descripción corta: ${description.slice(0, 400)}`);

  lines.push(`Palabra Clave SEO: ${buildSeoKeywords(product)}`);
  lines.push('ESTADO: Listo');

  return lines.join('\n');
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
  const { out, ...base } = parseArgs();
  const products = await fetchAllProducts(base);
  const issues: Issue[] = [];
  const blocks: string[] = [];

  for (const [index, product] of products.entries()) {
    const variations =
      product.type === 'variable'
        ? await wcGet<WcVariation[]>(base, `/products/${product.id}/variations?per_page=100`)
        : [];

    const block = buildBlock(product, variations, issues);
    if (block) blocks.push(block);
    process.stderr.write(`\rBloques generados: ${blocks.length}/${index + 1}`);
  }
  process.stderr.write('\n');

  const header = [
    '# Catálogo de productos',
    `# Generado desde WooCommerce el ${new Date().toISOString().slice(0, 10)}`,
    '# El stock y el precio se consultan en WooCommerce en tiempo real.',
  ].join('\n');

  await writeFile(out, `${header}\n\n---\n${blocks.join('\n\n---\n')}\n`, 'utf8');

  const skuCount = blocks.reduce(
    (total, block) => total + (block.match(/^SKU: ([\s\S]*?)(?=\n[A-ZÁÉÍÓÚ])/m)?.[1]?.split('\n').length ?? 0),
    0
  );

  console.error(`\n${out}: ${blocks.length} productos, ${skuCount} SKU vendibles.`);
  reportDataIssues(products, issues);
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
