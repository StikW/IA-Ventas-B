/**
 * Genera el `.txt` de catálogo que el negocio vectoriza (RAG).
 *
 * El panel **Documentos → Actualizar catálogo** usa la misma lógica
 * (`catalogTxt.builder.ts`). Este script sigue sirviendo para generar el archivo
 * en local o diagnosticar la tienda desde la consola.
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
  buildCatalogTxt,
  formatCatalogIssuesReport,
  type CatalogTxtProduct,
  type CatalogTxtVariation,
} from '../src/modules/knowledge/application/services/catalogTxt.builder';
import { readFlag, resolveWcCredentials, wcGet, type WcCredentials } from './wc-credentials';

async function fetchAllProducts(base: WcCredentials): Promise<CatalogTxtProduct[]> {
  const all: CatalogTxtProduct[] = [];
  for (let page = 1; ; page++) {
    const batch = await wcGet<CatalogTxtProduct[]>(
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

async function main(): Promise<void> {
  const out = readFlag('--out') ?? 'catalogo.txt';
  const base = await resolveWcCredentials();
  console.error(`Tienda: ${base.storeUrl} (credenciales: ${base.source})`);

  const products = await fetchAllProducts(base);
  const entries: Array<{ product: CatalogTxtProduct; variations: CatalogTxtVariation[] }> = [];

  for (const [index, product] of products.entries()) {
    const variations =
      product.type === 'variable'
        ? await wcGet<CatalogTxtVariation[]>(base, `/products/${product.id}/variations?per_page=100`)
        : [];
    entries.push({ product, variations });
    process.stderr.write(`\rBloques leídos: ${index + 1}/${products.length}`);
  }
  process.stderr.write('\n');

  const result = buildCatalogTxt(entries);
  await writeFile(out, result.text, 'utf8');

  console.error(
    `\n${out}: ${result.stats.productCount} productos, ${result.stats.skuCount} SKU vendibles, ${result.stats.packCount} a granel.`
  );
  console.error(`\n${formatCatalogIssuesReport(result.issues)}`);
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
