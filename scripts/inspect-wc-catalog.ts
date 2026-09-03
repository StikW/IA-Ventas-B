/**
 * Diagnóstico de la estructura de productos en WooCommerce.
 *
 * Responde: ¿los productos que se venden por paquetes (balines, canutillos) son
 * variaciones WC, o productos simples con los tiers en meta de `woo-massi`?
 * De esa respuesta depende qué debe emitir `generate-catalog-txt.ts` en el `.txt` del RAG.
 *
 * Uso:
 *   npx tsx scripts/inspect-wc-catalog.ts --filter balin
 *   npx tsx scripts/inspect-wc-catalog.ts --tenant <id> --filter canutillo --json out.json
 *
 * Credenciales: de la config WooCommerce del tenant en DynamoDB, o de
 * WC_STORE_URL / WC_CONSUMER_KEY / WC_CONSUMER_SECRET.
 */

import { writeFile } from 'node:fs/promises';

import {
  parsePackTiersFromHtml,
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
  regular_price: string;
  permalink: string;
  short_description: string;
  stock_status: string;
  categories: WcTerm[];
  tags: WcTerm[];
  attributes: Array<{ name: string; options: string[]; variation?: boolean }>;
  meta_data: WcMeta[];
  images?: Array<{ id: number; src: string; alt?: string }>;
  variations?: number[];
}

interface WcVariation {
  id: number;
  sku: string;
  price: string;
  stock_status: string;
  attributes: Array<{ name: string; option: string }>;
}

interface ProductReport {
  id: number;
  name: string;
  sku: string;
  type: string;
  price: string;
  categories: string[];
  imageCount: number;
  permalink: string;
  packModel: 'variaciones' | 'meta-tiers' | 'html-tiers' | 'ninguno';
  tiers: PackTier[] | null;
  tierMetaKey: string | null;
  variations: Array<{ sku: string; label: string; price: string }>;
  packMetaKeys: string[];
}

function plain(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

async function fetchAllProducts(credentials: WcCredentials): Promise<WcProduct[]> {
  const all: WcProduct[] = [];
  for (let page = 1; ; page++) {
    const batch = await wcGet<WcProduct[]>(
      credentials,
      `/products?per_page=100&page=${page}&status=publish&orderby=id&order=asc`
    );
    all.push(...batch);
    process.stderr.write(`\rProductos leídos: ${all.length}`);
    if (batch.length < 100) break;
  }
  process.stderr.write('\n');
  return all;
}

const PACK_META_HINT = /(tier|promo|pack|bulk|granel|escalon|wm_)/i;

async function tiersFromHtml(permalink: string): Promise<PackTier[] | null> {
  if (!permalink) return null;
  try {
    const response = await fetch(permalink, { headers: { 'User-Agent': 'ia-ventas-inspector' } });
    if (!response.ok) return null;
    return parsePackTiersFromHtml(await response.text());
  } catch {
    return null;
  }
}

async function inspectProduct(credentials: WcCredentials, product: WcProduct): Promise<ProductReport> {
  const variations: ProductReport['variations'] =
    product.type === 'variable'
      ? (await wcGet<WcVariation[]>(credentials, `/products/${product.id}/variations?per_page=100`)).map((variation) => ({
          sku: variation.sku,
          label: variation.attributes.map((attribute) => attribute.option).join(' '),
          price: variation.price,
        }))
      : [];

  const metaTiers = parsePackTiersFromMeta(product.meta_data);
  const tierMetaKey =
    metaTiers && product.meta_data.find((meta) => parsePackTiersFromMeta([meta]))?.key
      ? product.meta_data.find((meta) => parsePackTiersFromMeta([meta]))!.key
      : null;

  const htmlTiers = metaTiers || variations.length ? null : await tiersFromHtml(product.permalink);
  const tiers = metaTiers ?? htmlTiers;

  const packModel: ProductReport['packModel'] = variations.length
    ? 'variaciones'
    : metaTiers
      ? 'meta-tiers'
      : htmlTiers
        ? 'html-tiers'
        : 'ninguno';

  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    type: product.type,
    price: product.price,
    categories: product.categories.map((category) => category.name),
    imageCount: product.images?.length ?? 0,
    permalink: product.permalink,
    packModel,
    tiers,
    tierMetaKey,
    variations,
    packMetaKeys: product.meta_data.filter((meta) => PACK_META_HINT.test(meta.key)).map((meta) => meta.key),
  };
}

function printReport(reports: ProductReport[]): void {
  for (const report of reports) {
    console.log(`\n#${report.id} ${report.name}`);
    console.log(`  SKU: ${report.sku || '(vacío)'} · tipo: ${report.type} · precio: ${report.price || '(sin precio)'}`);
    console.log(`  Categorías: ${report.categories.join(', ') || '(ninguna)'} · imágenes: ${report.imageCount}`);
    console.log(`  Modelo de paquetes: ${report.packModel}`);
    if (report.tiers) {
      const detail = report.tiers.map((tier) => `x${tier.units}=${tier.price}`).join('  ');
      console.log(`  Tiers${report.tierMetaKey ? ` (meta ${report.tierMetaKey})` : ' (HTML data-tiers)'}: ${detail}`);
    }
    if (report.variations.length) {
      for (const variation of report.variations) {
        console.log(`    · ${variation.label || '(sin label)'} → ${variation.sku || '(sin SKU)'} = ${variation.price}`);
      }
    }
    if (report.packMetaKeys.length) {
      console.log(`  Meta candidatas: ${[...new Set(report.packMetaKeys)].join(', ')}`);
    }
  }

  const byModel = new Map<string, number>();
  for (const report of reports) byModel.set(report.packModel, (byModel.get(report.packModel) ?? 0) + 1);

  console.log('\nResumen por modelo de paquetes:');
  for (const [model, count] of [...byModel].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${model}: ${count}`);
  }
}

async function main(): Promise<void> {
  const credentials = await resolveWcCredentials();
  console.error(`Tienda: ${credentials.storeUrl} (credenciales: ${credentials.source})`);

  const filter = readFlag('--filter') ? plain(readFlag('--filter')!) : undefined;
  const limit = Number.parseInt(readFlag('--limit') ?? '', 10);
  const all = await fetchAllProducts(credentials);

  let selected = filter
    ? all.filter(
        (product) =>
          plain(product.name).includes(filter) ||
          plain(product.sku).includes(filter) ||
          product.categories.some((category) => plain(category.name).includes(filter))
      )
    : all;
  if (Number.isFinite(limit) && limit > 0) selected = selected.slice(0, limit);

  console.error(`Analizando ${selected.length} de ${all.length} productos...`);

  const reports: ProductReport[] = [];
  for (const [index, product] of selected.entries()) {
    reports.push(await inspectProduct(credentials, product));
    process.stderr.write(`\rAnalizados: ${index + 1}/${selected.length}`);
  }
  process.stderr.write('\n');

  printReport(reports);

  const json = readFlag('--json');
  if (json) {
    await writeFile(json, JSON.stringify(reports, null, 2), 'utf8');
    console.error(`\nDetalle completo en ${json}`);
  }
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
