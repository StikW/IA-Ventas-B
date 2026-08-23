import { inject, injectable } from 'tsyringe';
import { hasOpenAI } from '../../../../shared/infrastructure/config/env';
import { RagSearchService } from '../../../knowledge/application/services/RagSearchService';
import { OrderItem } from '../../../commerce/domain/entities/Order.types';
import { IMassiBotService, MassiBotVariation } from '../../../massi-bot/domain/IMassiBotService';
import { IWooCommerceConfigRepository, IWooCommerceService, WooCommerceConfigData, WooCommerceProduct } from '../../../woocommerce/domain/IWooCommerceService';
import { OfferedOption, SalesContext } from '../../domain/IChatSessionRepository';
import { PendingCartItem } from '../../domain/IChatSessionRepository';
import { DomainError } from '../../../../shared/domain/errors/DomainError';
import {
  extractExplicitSkus,
  extractProductFamilyTerm,
  extractQuantityFromText,
  extractVariantHint,
  cartItemMatchesVariantHint,
  isCartSiblingVariantIntent,
  isSameProductReference,
  looksLikeSku,
  normalizeProductText,
  parseMultiVariantSelection,
  parseMultiProductSelection,
  normalizeUserTypos,
  isCatalogBrowseIntent,
  isProductOptionsBrowseIntent,
  themeListLabel,
  parseProductSelectionQuery,
  SELECTION_NOISE_WORDS,
  tokenizeProductQuery,
  VARIANT_STRIP_PATTERN,
} from '../../domain/productSelection.utils';
import { extractCatalogRefsFromChunks, RagCatalogMatch, resolveSkuFromRagChunks } from '../../domain/catalogRag.utils';
import { buildCheckoutFormUrl } from '../../domain/checkoutLink.utils';
import {
  buildProductQueryFromTarget,
  describeCartTarget,
  extractCartTarget,
  extractSpokenQuantity,
  hasProductReference,
  isCartClearIntent,
  isCartCorrectionIntent,
  isCartIncrementIntent,
  isCartIncrementPhrase,
  isCartKeepOnlyIntent,
  isCartRemoveIntent,
  isCartSetQuantityIntent,
  parseCartCorrection,
  parseCartKeepOnly,
  parseCartRemove,
  parseCartSetQuantity,
  splitCartEditClauses,
} from '../../domain/cartModification.utils';
import {
  buildAmbiguousProductMessage,
  buildFamilyProductListMessage,
  buildProductFamilyVariantsMessage,
  formatSimpleProductLineForUser,
  formatVariationLineForUser,
  toOfferedOptionFromProduct,
  toOfferedOptionFromVariation,
  PRODUCT_LIST_MAX_LINES,
} from '../../domain/productDisplay.utils';
import { CatalogMatch, catalogQueryTokens, isDecisiveMatch, rankCatalogEntries } from '../../domain/catalogMatch.utils';
import { EMOJI } from '../../domain/tone.utils';
import { BusinessProfileConfig } from '../../../tenant/domain/entities/Config.types';
import { CartService } from './CartService';
import { CatalogIndexService } from './CatalogIndexService';

/** Variaciones que caben en un mensaje de WhatsApp sin volverse ilegible. */
const PRODUCT_VARIATION_MAX_LINES = 12;

export interface ProductResolution {
  ok: boolean;
  message: string;
  item?: OrderItem;
  /**
   * El mensaje ya contiene un listado de opciones con su ID. El agente debe mostrarlo
   * en vez de responder con la ayuda genérica de «envíame el ID».
   */
  needsChoice?: boolean;
  /** Opciones listadas, para resolver después «el primero». */
  options?: OfferedOption[];
}

export interface ProductResolutionBatch {
  ok: boolean;
  message: string;
  items?: OrderItem[];
  needsChoice?: boolean;
  options?: OfferedOption[];
}

/** Listado de productos u opciones mostrado al cliente. */
export interface ProductBrowseResult {
  ok: boolean;
  message: string;
  options?: OfferedOption[];
}

export interface StockCheckResult {
  available: boolean;
  sku: string;
  name: string;
  quantity: number;
  stockStatus: string;
  stockQuantity: number | null;
  message: string;
}

@injectable()
export class SalesAgentToolsHandler {
  constructor(
    @inject(RagSearchService) private readonly ragSearch: RagSearchService,
    @inject('IWooCommerceConfigRepository') private readonly wcConfigRepo: IWooCommerceConfigRepository,
    @inject('IWooCommerceService') private readonly wcService: IWooCommerceService,
    @inject('IMassiBotService') private readonly massiBot: IMassiBotService,
    @inject(CatalogIndexService) private readonly catalogIndex: CatalogIndexService
  ) {}

  async searchDocuments(tenantId: string, query: string): Promise<string> {
    const [primary, similar] = await Promise.all([
      this.ragSearch.search({ tenantId, query, topK: 5, minScore: 0.45 }),
      this.ragSearch.search({ tenantId, query, topK: 5, minScore: 0.32 }),
    ]);

    const primaryIds = new Set(primary.results.map((r) => `${r.documentId}:${r.chunkIndex}`));
    const related = similar.results.filter((r) => !primaryIds.has(`${r.documentId}:${r.chunkIndex}`));

    const format = (results: typeof primary.results, label: string) => {
      if (!results.length) return `${label}: sin resultados.`;
      return `${label}:\n${results
        .map((r, i) => `[${i + 1}] (${r.source}, score ${r.score.toFixed(2)}) ${r.content}`)
        .join('\n')}`;
    };

    return [format(primary.results, 'Resultados principales'), format(related, 'Productos o temas relacionados')].join(
      '\n\n'
    );
  }

  /**
   * RAG → SKU: interpreta lenguaje natural con el catálogo vectorizado (.txt).
   * Stock/precio se validan después en WooCommerce.
   */
  async resolveSkuFromRag(
    tenantId: string,
    userText: string,
    variantHint?: string
  ): Promise<RagCatalogMatch | null> {
    if (!hasOpenAI) return null;

    try {
      const ragQuery = variantHint ? `${userText} ${variantHint}`.trim() : userText;
      const [primary, similar] = await Promise.all([
        this.ragSearch.search({ tenantId, query: ragQuery, topK: 8, minScore: 0.38 }),
        this.ragSearch.search({ tenantId, query: userText, topK: 6, minScore: 0.32 }),
      ]);

      const seen = new Set<string>();
      const chunks = [...primary.results, ...similar.results]
        .filter((row) => {
          const key = `${row.documentId}:${row.chunkIndex}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((row) => ({ content: row.content, score: row.score }));

      return resolveSkuFromRagChunks(chunks, userText, variantHint);
    } catch {
      return null;
    }
  }

  /** Catálogo legible para WhatsApp — solo productos publicados en WooCommerce. */
  async formatStoreCatalogForWhatsApp(tenantId: string): Promise<string> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return 'No pude consultar la tienda en este momento. Intenta de nuevo en unos segundos.';
    }

    try {
      const products = await this.wcService.listProducts(config, 1);
      if (!products.length) {
        return 'No hay productos publicados en la tienda online en este momento.';
      }

      const lines: string[] = ['Estos son los productos disponibles en nuestra tienda online:\n'];
      let index = 1;

      for (const product of products.slice(0, 8)) {
        if (product.type === 'variable') {
          try {
            const variations = await this.loadVariations(config, product);
            lines.push(`${index}. *${product.name}*`);
            for (const variation of variations.slice(0, 12)) {
              const label = variation.name.replace(product.name, '').trim() || variation.name;
              const price = Number.parseFloat(variation.price);
              const priceLabel = Number.isFinite(price) ? `$${price.toLocaleString('es-CO')}` : variation.price;
              lines.push(`   - ${label || variation.name}: ${priceLabel}`);
            }
          } catch {
            lines.push(`${index}. *${product.name}* (consulta variaciones en tienda)`);
          }
        } else {
          const price = Number.parseFloat(product.price);
          const priceLabel = Number.isFinite(price) ? `$${price.toLocaleString('es-CO')}` : product.price;
          lines.push(`${index}. *${product.name}* — ${priceLabel}`);
        }
        index += 1;
      }

      lines.push(
        '\nSi te interesa alguno, indícame cuál y la variante (medida, talla, etc.) y lo agrego a tu pedido.'
      );
      return lines.join('\n');
    } catch (err) {
      return this.formatStoreError(err);
    }
  }

  async searchStoreProducts(tenantId: string, query: string): Promise<string> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) return 'WooCommerce no está conectado para este negocio.';

    try {
      return await this.searchStoreProductsInner(config, query);
    } catch (err) {
      return this.formatStoreError(err);
    }
  }

  private async searchStoreProductsInner(config: WooCommerceConfigData, query: string): Promise<string> {
    const trimmed = query.trim();
    const bySku = await this.resolveProductBySku(config, trimmed);
    if (bySku) {
      return this.formatResolvedSkuProduct(bySku);
    }

    const parsed = parseProductSelectionQuery(trimmed);
    const products = await this.searchProductsWithFallback(config, parsed.productQuery || trimmed);
    if (!products.length) {
      return `No se encontraron productos para "${query}". Prueba con el SKU exacto o un nombre más corto del producto.`;
    }

    const lines: string[] = [
      'Resultados (cada variación tiene SKU único — úsalo para stock y compra):',
    ];
    for (const p of products.slice(0, 5)) {
      lines.push(this.formatProduct(p));
      if (p.type === 'variable') {
        try {
          const variations = await this.loadVariations(config, p);
          for (const v of variations.slice(0, 12)) {
            lines.push(`    ↳ ${this.formatVariationLine(v)}`);
          }
        } catch {
          lines.push(`    ↳ (no se pudieron cargar variaciones de productId=${p.id})`);
        }
      }
    }
    lines.push(
      '\nIMPORTANTE: Cuando el cliente elija una opción, usa agregar_producto_por_sku con el SKU exacto de esa variación.'
    );
    return lines.join('\n');
  }

  /**
   * Cliente pregunta por un tipo de producto (cadena, anillo…): busca el padre en WC y
   * devuelve variaciones con *ID* visible (internamente SKU).
   */
  async resolveProductFamilyBrowse(tenantId: string, userText: string): Promise<ProductBrowseResult> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return { ok: false, message: 'WooCommerce no está conectado para este negocio.' };
    }

    const family = extractProductFamilyTerm(userText);
    if (!family) return { ok: false, message: '' };

    try {
      const parsed = parseProductSelectionQuery(normalizeUserTypos(userText));
      const variantHint = parsed.variantHint ?? extractVariantHint(userText);

      const { products: familyProducts, resolvedTerm, matches } =
        await this.catalogIndex.findFamilyRanked(
          config.tenantId,
          config,
          family,
          userText,
          variantHint
        );

      // El cliente nombró un producto concreto ("opciones del anillo dama flor"):
      // sus variaciones con ID, no otro listado de la familia.
      if (matches.length && this.shouldDescribeNamedProduct(userText, matches)) {
        return await this.describeProductOptions(config, matches[0]!.entry.product, variantHint);
      }

      // Varios productos del mismo tipo: se listan para que el cliente elija por ID.
      if (familyProducts.length > 1) {
        const shown = familyProducts.slice(0, PRODUCT_LIST_MAX_LINES);
        return {
          ok: true,
          message: buildFamilyProductListMessage(resolvedTerm, shown, familyProducts.length),
          options: shown.map(toOfferedOptionFromProduct),
        };
      }

      const parent =
        familyProducts[0] ??
        this.pickBestParentProduct(
          await this.searchProductsWithFallback(config, (parsed.productQuery || family).trim() || family),
          userText,
          family
        );

      if (!parent) {
        return { ok: false, message: `No encontré ${family} en la tienda en este momento.` };
      }

      return await this.describeProductOptions(config, parent, variantHint);
    } catch (err) {
      return { ok: false, message: this.formatStoreError(err) };
    }
  }

  /**
   * Opciones de un producto que ya se le mostró al cliente. Se usa cuando responde con la
   * posición ("el primero") sobre un producto variable, que no tiene SKU propio.
   */
  async describeProductOptionsById(tenantId: string, productId: number): Promise<ProductBrowseResult> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return { ok: false, message: 'WooCommerce no está conectado para este negocio.' };
    }

    try {
      const entries = await this.catalogIndex.getEntries(tenantId, config);
      const product =
        entries.find((entry) => entry.product.id === productId)?.product ??
        (await this.wcService.getProductById(config, productId));

      if (!product) {
        return { ok: false, message: 'Ese producto ya no está disponible en la tienda.' };
      }

      return await this.describeProductOptions(config, product);
    } catch (err) {
      return { ok: false, message: this.formatStoreError(err) };
    }
  }

  /**
   * Motivo o forma ("alguna joya en forma de corazón"): lista coincidencias del índice
   * con su ID, sin pasar por el LLM ni inventar precios.
   */
  async resolveThemeBrowse(tenantId: string, userText: string): Promise<ProductBrowseResult> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return { ok: false, message: 'WooCommerce no está conectado para este negocio.' };
    }

    try {
      const variantHint = extractVariantHint(userText);
      let matches = await this.catalogIndex.search(
        tenantId,
        config,
        userText,
        variantHint,
        PRODUCT_LIST_MAX_LINES
      );

      if (!matches.length) {
        matches = await this.searchThemeProductsFromRag(tenantId, config, userText);
      }

      if (!matches.length) {
        return {
          ok: false,
          message:
            'No encontré piezas con esa forma en la tienda. Prueba con un nombre más concreto (elefante, corazón, virgen…) o el *ID*.',
        };
      }

      if (this.shouldDescribeNamedProduct(userText, matches) && matches[0]!.entry.product.type === 'variable') {
        return await this.describeProductOptions(config, matches[0]!.entry.product, variantHint);
      }

      const shown = matches.map((match) => match.entry.product).slice(0, PRODUCT_LIST_MAX_LINES);
      return {
        ok: true,
        message: buildFamilyProductListMessage(themeListLabel(userText), shown, matches.length),
        options: shown.map(toOfferedOptionFromProduct),
      };
    } catch (err) {
      return { ok: false, message: this.formatStoreError(err) };
    }
  }

  /**
   * "animales" no aparece en los nombres; el RAG del .txt sí relaciona elefante, mariposa…
   * Solo se listan productos que existan en WooCommerce.
   */
  private async searchThemeProductsFromRag(
    tenantId: string,
    config: WooCommerceConfigData,
    userText: string
  ): Promise<CatalogMatch[]> {
    if (!hasOpenAI) return [];

    try {
      const rag = await this.ragSearch.search({ tenantId, query: userText, topK: 10, minScore: 0.3 });
      if (!rag.results.length) return [];

      const entries = await this.catalogIndex.getEntries(tenantId, config);
      if (!entries.length) return [];

      const hints = extractCatalogRefsFromChunks(rag.results);
      const found = new Map<number, CatalogMatch>();

      const add = (match: CatalogMatch) => {
        const current = found.get(match.entry.product.id);
        if (!current || match.score > current.score) found.set(match.entry.product.id, match);
      };

      for (const sku of hints.skus) {
        const entry = entries.find((row) => row.product.sku?.toLowerCase() === sku.toLowerCase());
        if (entry) add({ entry, score: 10, matchedTokens: 1 });
      }

      for (const name of hints.names) {
        const ranked = rankCatalogEntries(entries, catalogQueryTokens(name), undefined, 1);
        if (ranked[0]) add(ranked[0]);
      }

      return [...found.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, PRODUCT_LIST_MAX_LINES);
    } catch {
      return [];
    }
  }

  /**
   * El cliente señaló un producto concreto (nombre propio, no solo "anillo") o pidió
   * explícitamente sus opciones. En ambos casos se listan las variaciones, no la familia.
   */
  private shouldDescribeNamedProduct(userText: string, matches: CatalogMatch[]): boolean {
    if (!matches.length) return false;
    if (isDecisiveMatch(matches)) return true;
    if (!isProductOptionsBrowseIntent(userText)) return false;

    const extra = catalogQueryTokens(userText).filter((token) => !extractProductFamilyTerm(token));
    return extra.length >= 1;
  }

  /**
   * MASSI es la fuente preferida de variaciones; si falla o no está, WooCommerce REST
   * alcanza para listar tallas/colores con SKU.
   */
  private async loadVariations(
    config: WooCommerceConfigData,
    parent: Pick<WooCommerceProduct, 'id'> & { name?: string }
  ): Promise<MassiBotVariation[]> {
    if (this.massiBot.isConfigured(config)) {
      try {
        const fromMassi = await this.massiBot.getProductVariations(config, parent.id);
        if (Array.isArray(fromMassi) && fromMassi.length) return fromMassi;
      } catch {
        // Sigue con WooCommerce: un 404/502 de MASSI no debe tumbar el listado.
      }
    }

    const parentName = parent.name?.trim() ?? '';
    const fromStore = await this.wcService.listProductVariations(config, parent.id);
    return fromStore.map((variation) => ({
      id: variation.id,
      parentId: parent.id,
      name: [parentName, variation.name].filter(Boolean).join(' - '),
      sku: variation.sku,
      price: variation.price,
      stockStatus: variation.stockStatus,
      stockQuantity: variation.stockQuantity,
      attributes: (variation.tags ?? [])
        .map((tag) => {
          const [name, value] = tag.split(':').map((part) => part.trim());
          return { name: name || 'Opción', value: value || tag };
        })
        .filter((attribute) => attribute.value),
      isVariation: true,
    }));
  }

  /** Un producto concreto: sus variaciones con ID, o su ficha si es simple. */
  private async describeProductOptions(
    config: WooCommerceConfigData,
    parent: WooCommerceProduct,
    variantHint?: string
  ): Promise<ProductBrowseResult> {
    if (parent.type !== 'variable') {
      return {
        ok: true,
        message: buildProductFamilyVariantsMessage(parent.name, [
          formatSimpleProductLineForUser(parent, 1),
        ]),
        options: [toOfferedOptionFromProduct(parent)],
      };
    }

    let variations = await this.loadVariations(config, parent);
    if (!variations.length) {
      return { ok: false, message: `*${parent.name}* no tiene opciones publicadas aún.` };
    }

    if (variantHint) {
      const filtered = variations.filter((variation) =>
        cartItemMatchesVariantHint({ name: variation.name, sku: variation.sku }, variantHint)
      );
      if (filtered.length) variations = filtered;
    }

    const shown = variations.slice(0, PRODUCT_VARIATION_MAX_LINES);
    const lines = shown.map((variation, index) => formatVariationLineForUser(variation, index + 1));

    return {
      ok: true,
      message: buildProductFamilyVariantsMessage(parent.name, lines, variantHint),
      options: shown.map((variation) => toOfferedOptionFromVariation(variation, parent.name)),
    };
  }

  private pickBestParentProduct(
    products: WooCommerceProduct[],
    userText: string,
    family: string
  ): WooCommerceProduct | undefined {
    const parsed = parseProductSelectionQuery(normalizeUserTypos(userText));
    const queryTokens = tokenizeProductQuery(parsed.productQuery || family);

    let best: { product: WooCommerceProduct; score: number } | undefined;

    for (const product of products) {
      const blob = normalizeProductText(product.name);
      let score = 0;
      if (blob.includes(family)) score += 25;
      if (product.type === 'variable') score += 15;
      for (const token of queryTokens) {
        if (blob.includes(token)) score += 10;
      }
      if (!best || score > best.score) best = { product, score };
    }

    return best?.product;
  }

  async checkStock(
    tenantId: string,
    input: {
      sku?: string;
      productId?: number;
      variationId?: number;
      variantHint?: string;
      productName?: string;
      quantity: number;
    }
  ): Promise<StockCheckResult> {
    let { sku, productId, variationId, quantity } = input;
    let variantHint = input.variantHint?.trim();
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return {
        available: false,
        sku: sku ?? '',
        name: sku ?? String(productId ?? ''),
        quantity,
        stockStatus: 'unknown',
        stockQuantity: null,
        message: 'WooCommerce no conectado.',
      };
    }

    if (sku?.trim()) {
      const resolved = await this.resolveProductBySku(config, sku.trim());
      if (resolved) {
        return this.stockResultFromResolved(resolved, quantity);
      }
      return {
        available: false,
        sku: sku.trim(),
        name: sku.trim(),
        quantity,
        stockStatus: 'notfound',
        stockQuantity: null,
        message: `Producto con SKU "${sku.trim()}" no encontrado. Verifica el SKU en buscar_productos_tienda.`,
      };
    }

    if (!productId && input.productName?.trim()) {
      const parsed = parseProductSelectionQuery(input.productName.trim());
      if (!variantHint && parsed.variantHint) variantHint = parsed.variantHint;
      const found = await this.searchProductsWithFallback(config, parsed.productQuery);
      if (found[0]) productId = found[0].id;
    }

    if (productId && variantHint && !variationId) {
      try {
        const variations = await this.loadVariations(config, { id: productId });
        const matched = this.matchVariation(variations, variantHint);
        if (matched) {
          variationId = matched.id;
          if (!sku && matched.sku) sku = matched.sku;
        }
      } catch {
        // continuar sin variationId
      }
    }

    if (variationId && productId) {
      try {
        const variations = await this.loadVariations(config, { id: productId });
        const variation = variations.find((v) => v.id === variationId);
        if (!variation) {
          return {
            available: false,
            sku: sku ?? '',
            name: String(productId),
            quantity,
            stockStatus: 'notfound',
            stockQuantity: null,
            message: `Variación ${variationId} no encontrada para el producto ${productId}.`,
          };
        }
        const available = this.isVariationAvailable(variation, quantity);
        return {
          available,
          sku: variation.sku || sku || '',
          name: variation.name,
          quantity,
          stockStatus: variation.stockStatus,
          stockQuantity: variation.stockQuantity,
          message: available
            ? `Disponible: ${variation.name} | SKU: ${variation.sku || sku || 'SIN SKU'} | productId=${productId}, variationId=${variation.id} | cantidad ${quantity} | precio ${variation.price}. Usa este SKU en preparar_pago.`
            : `Sin stock para ${variation.name} (SKU ${variation.sku || sku || '—'}). Estado: ${variation.stockStatus}.`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error al consultar variaciones';
        return {
          available: false,
          sku: sku ?? '',
          name: String(productId),
          quantity,
          stockStatus: 'error',
          stockQuantity: null,
          message: msg,
        };
      }
    }

    if (productId) {
      const product = await this.wcService.getProductById(config, productId);
      if (!product) {
        return {
          available: false,
          sku: sku ?? '',
          name: String(productId),
          quantity,
          stockStatus: 'notfound',
          stockQuantity: null,
          message: `Producto ID ${productId} no encontrado.`,
        };
      }

      if (product.type === 'variable') {
        const variations = await this.loadVariations(config, product);
        if (!variations.length) {
          return {
            available: false,
            sku: product.sku,
            name: product.name,
            quantity,
            stockStatus: product.stockStatus,
            stockQuantity: null,
            message: `${product.name} es variable pero no tiene variaciones publicadas. productId=${productId}.`,
          };
        }
        const lines = variations.map(
          (v) =>
            `  · SKU: ${v.sku || 'SIN SKU'} | ${v.name} | variationId=${v.id} | precio ${v.price} | stock ${v.stockStatus}${
              v.stockQuantity != null ? ` (${v.stockQuantity})` : ''
            }`
        );
        return {
          available: false,
          sku: product.sku,
          name: product.name,
          quantity,
          stockStatus: 'variable',
          stockQuantity: null,
          message: [
            `Producto encontrado: ${product.name} (productId=${productId}). Es variable — opciones:`,
            ...lines,
            variantHint
              ? `No encontré variación que coincida con "${variantHint}". Pide al cliente el SKU exacto o aclara la medida.`
              : 'Cuando el cliente elija, usa verificar_stock con el SKU de la variación.',
          ].join('\n'),
        };
      }

      const available = this.isProductAvailable(product, quantity);
      return {
        available,
        sku: product.sku,
        name: product.name,
        quantity,
        stockStatus: product.stockStatus,
        stockQuantity: product.stockQuantity,
        message: available
          ? `Disponible: ${product.name} | SKU: ${product.sku} | productId=${product.id} | cantidad ${quantity} | precio ${product.price}.`
          : `Sin stock suficiente para ${product.name} (SKU ${product.sku}). Estado: ${product.stockStatus}.`,
      };
    }

    return {
      available: false,
      sku: '',
      name: '',
      quantity,
      stockStatus: 'unknown',
      stockQuantity: null,
      message: 'Indica el SKU exacto del producto o variación (preferido). Alternativa: product_id + variante.',
    };
  }

  async listVariations(tenantId: string, productId: number): Promise<string> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) return 'WooCommerce no conectado.';
    const variations = await this.loadVariations(config, { id: productId });
    if (!variations.length) return `Sin variaciones para productId=${productId}.`;

    return variations
      .map((v) => {
        const attrs = v.attributes.map((a) => `${a.name}: ${a.value}`).join(', ');
        const stock =
          v.stockQuantity != null ? `${v.stockStatus} (${v.stockQuantity} uds.)` : v.stockStatus;
        return `- SKU: ${v.sku || 'SIN SKU'} | ${v.name} | variationId=${v.id} | productId=${v.parentId} | Precio: ${v.price} | ${attrs || 'sin atributos'} | Stock: ${stock}`;
      })
      .join('\n');
  }

  async validateCartStock(tenantId: string, items: OrderItem[]): Promise<{ ok: boolean; message: string }> {
    const checks = await Promise.all(
      items.map((item) =>
        this.checkStock(tenantId, {
          sku: item.sku,
          productId: item.productId,
          variationId: item.variationId,
          quantity: item.quantity,
        })
      )
    );
    const unavailable = checks.filter((c) => !c.available);
    if (unavailable.length) {
      return {
        ok: false,
        message: unavailable.map((c) => c.message).join(' '),
      };
    }
    return { ok: true, message: 'Todos los productos tienen stock disponible.' };
  }

  buildAwaitingPaymentContext(
    salesContext: SalesContext,
    items: OrderItem[],
    customerName: string,
    massiOrder?: { orderId: number; orderNumber: string; ticketCode?: string; paymentMethod?: string }
  ): SalesContext {
    return {
      phase: 'awaiting_payment',
      flowStep: undefined,
      cartItems: items,
      customerName,
      lastOrderId: salesContext.lastOrderId,
      massiWooOrderId: massiOrder?.orderId,
      massiWooOrderNumber: massiOrder?.orderNumber,
      massiTicketCode: massiOrder?.ticketCode,
      paymentMethod: massiOrder?.paymentMethod,
    };
  }

  async createMassiOrder(
    tenantId: string,
    customerPhone: string,
    customerName: string,
    items: OrderItem[],
    paymentMethod = 'mdp_788'
  ): Promise<{ ok: boolean; message: string; order?: { orderId: number; orderNumber: string; ticketCode: string } }> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected || !this.massiBot.isConfigured(config)) {
      return { ok: false, message: 'MASSI Bot API no configurada para crear pedidos completos.' };
    }

    try {
      const order = await this.massiBot.createOrder(config, {
        phone: customerPhone,
        customerName,
        paymentMethod,
        deliveryType: 'pickup',
        lineItems: items.map((item) => ({
          productId: item.variationId ? item.productId : item.productId,
          variationId: item.variationId,
          quantity: item.quantity,
        })),
        idempotencyKey: `wa-${tenantId}-${customerPhone}-${items.map((i) => `${i.productId}x${i.quantity}`).join('-')}`,
      });
      return {
        ok: true,
        message: `Pedido MASSI #${order.number} creado. Ticket: ${order.ticketCode || 'pendiente'}.`,
        order: {
          orderId: order.id,
          orderNumber: order.number,
          ticketCode: order.ticketCode,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al crear pedido MASSI';
      return { ok: false, message: msg };
    }
  }

  async listMassiOrders(tenantId: string, phone: string): Promise<string> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected || !this.massiBot.isConfigured(config)) {
      return 'Consulta de pedidos MASSI no disponible.';
    }

    const orders = await this.massiBot.listOrdersByPhone(config, phone, 5);
    if (!orders.length) return 'No hay pedidos recientes para este teléfono.';

    return orders
      .map(
        (o) =>
          `- Pedido #${o.number} | Ticket ${o.ticketCode || '—'} | ${o.operationalLabel || o.operationalStatus} | Total ${o.total} ${o.currency}`
      )
      .join('\n');
  }

  async submitMassiPaymentProof(
    tenantId: string,
    phone: string,
    orderId: number,
    proofUrl: string
  ): Promise<{ ok: boolean; message: string; ticketCode?: string }> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected || !this.massiBot.isConfigured(config)) {
      return { ok: false, message: 'MASSI Bot API no configurada.' };
    }

    try {
      const result = await this.massiBot.submitPaymentReport(config, {
        orderId,
        phone,
        proofUrl,
        note: 'Comprobante enviado por WhatsApp',
      });
      return {
        ok: true,
        message: `Comprobante registrado. Estado: ${result.operationalLabel || result.operationalStatus}.`,
        ticketCode: result.ticketCode,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al registrar comprobante';
      return { ok: false, message: msg };
    }
  }

  massiBotEnabled(tenantId: string): Promise<boolean> {
    return this.wcConfigRepo.findByTenantId(tenantId).then((c) => !!(c && this.massiBot.isConfigured(c)));
  }

  async buildCheckoutFormLink(
    tenantId: string,
    customerPhone: string,
    cartItems: PendingCartItem[],
    businessProfile?: BusinessProfileConfig
  ): Promise<{ ok: boolean; url?: string; message: string }> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return { ok: false, message: 'WooCommerce no está conectado. Configura la tienda en el panel.' };
    }

    const result = buildCheckoutFormUrl({
      checkoutFormUrl: businessProfile?.checkoutFormUrl,
      checkoutPagePath: config.checkoutPagePath,
      storeUrl: config.storeUrl,
      customerPhone,
      cartItems,
    });

    if (!result.ok || !result.url) {
      return { ok: false, message: result.message ?? 'No se pudo generar el enlace de compra.' };
    }

    return { ok: true, url: result.url, message: result.url };
  }

  async buildOrderItemBySku(
    tenantId: string,
    sku: string,
    quantity = 1
  ): Promise<ProductResolution> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return { ok: false, message: 'WooCommerce no conectado.' };
    }

    let resolved;
    try {
      resolved = await this.resolveProductBySku(config, sku.trim());
    } catch (err) {
      return { ok: false, message: this.formatStoreError(err) };
    }

    if (!resolved) {
      return { ok: false, message: `Producto con SKU "${sku}" no encontrado.` };
    }

    return this.toOrderItemResult(resolved, quantity);
  }

  /**
   * Resuelve el `retailer_id` del catálogo Meta/WhatsApp → ítem de carrito WC.
   * Orden: SKU exacto → ID numérico WC → búsqueda por texto.
   */
  async buildOrderItemByRetailerId(
    tenantId: string,
    retailerId: string,
    quantity = 1
  ): Promise<ProductResolution> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return { ok: false, message: 'WooCommerce no conectado.' };
    }

    const id = retailerId.trim();
    if (!id) {
      return { ok: false, message: 'Producto sin retailerId.' };
    }

    try {
      const bySku = await this.resolveProductBySku(config, id);
      if (bySku) return this.toOrderItemResult(bySku, quantity);

      const numericId = Number.parseInt(id, 10);
      if (Number.isFinite(numericId) && String(numericId) === id) {
        const product = await this.wcService.getProductById(config, numericId);
        if (product) {
          const resolved = {
            productId: product.id,
            sku: product.sku || id,
            name: product.name,
            price: product.price,
            stockStatus: product.stockStatus,
            stockQuantity: product.stockQuantity,
          };
          return this.toOrderItemResult(resolved, quantity);
        }
      }

      const matches = await this.wcService.searchProducts(config, id);
      const exact =
        matches.find((p) => p.sku.trim().toLowerCase() === id.toLowerCase()) ??
        matches.find((p) => String(p.id) === id) ??
        matches[0];
      if (exact) {
        const resolved = {
          productId: exact.id,
          sku: exact.sku || id,
          name: exact.name,
          price: exact.price,
          stockStatus: exact.stockStatus,
          stockQuantity: exact.stockQuantity,
        };
        return this.toOrderItemResult(resolved, quantity);
      }
    } catch (err) {
      return { ok: false, message: this.formatStoreError(err) };
    }

    return { ok: false, message: `Producto "${id}" no encontrado en la tienda.` };
  }

  private toOrderItemResult(
    resolved: {
      productId: number;
      variationId?: number;
      sku: string;
      name: string;
      price: string;
      stockStatus: string;
      stockQuantity: number | null;
    },
    quantity: number
  ): { ok: boolean; message: string; item?: OrderItem } {
    if (!this.isResolvedAvailable(resolved, quantity)) {
      return {
        ok: false,
        message: `Sin stock para ${resolved.name} (SKU ${resolved.sku}). Estado: ${resolved.stockStatus}.`,
      };
    }

    const unitPrice = Number.parseFloat(resolved.price);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      return { ok: false, message: `Precio inválido para SKU ${resolved.sku}.` };
    }

    return {
      ok: true,
      message: `Disponible: ${resolved.name} | SKU: ${resolved.sku} | precio ${unitPrice}.`,
      item: {
        productId: resolved.productId,
        variationId: resolved.variationId,
        sku: resolved.sku,
        name: resolved.name,
        quantity,
        unitPrice,
      },
    };
  }

  /** Vaciar carrito, quitar productos o corregir cantidades (determinista). */
  async applyCartModification(
    tenantId: string,
    userText: string,
    cartItems: PendingCartItem[],
    context?: { lastAddedSkus?: string[] }
  ): Promise<{ handled: boolean; items: PendingCartItem[]; message: string }> {
    const items = cartItems ?? [];

    if (isCartClearIntent(userText)) {
      return {
        handled: true,
        items: CartService.clear(),
        message: `Listo, vacié tu carrito ${EMOJI.check} ¿Con qué empezamos de nuevo?`,
      };
    }

    if (isCartKeepOnlyIntent(userText)) {
      return await this.applyCartKeepOnly(tenantId, userText, items, context?.lastAddedSkus);
    }

    if (!items.length) {
      return { handled: false, items, message: '' };
    }

    if (isCartCorrectionIntent(userText)) {
      const parts = parseCartCorrection(userText);
      if (!parts) return { handled: false, items, message: '' };

      let next = [...items];
      const notes: string[] = [];

      if (parts.remove) {
        const removed = CartService.removeByTarget(next, parts.remove, parts.remove.quantity, true);
        next = removed.items;
        if (removed.removedQty > 0) {
          notes.push(`Quité del carrito: ${removed.removedNames.join(', ')}.`);
        } else {
          notes.push(`No encontré "${describeCartTarget(parts.remove)}" en tu carrito.`);
        }
      }

      const wantQuery = buildProductQueryFromTarget(parts.want);
      const existing = CartService.findByTarget(next, parts.want);
      if (existing) {
        next = CartService.setQuantityByTarget(next, parts.want, parts.want.quantity);
        notes.push(`Dejé ${parts.want.quantity} de ${existing.name}.`);
      } else if (wantQuery.trim()) {
        const resolved = await this.resolveSelectionFromTextInner(
          tenantId,
          wantQuery,
          parts.want.quantity,
          { cartItems: next }
        );
        if (resolved.ok && resolved.item) {
          next = CartService.merge(next, [{ ...resolved.item, quantity: parts.want.quantity }]);
          next = CartService.setQuantityByTarget(next, parts.want, parts.want.quantity);
          notes.push(`Agregué ${parts.want.quantity} de ${resolved.item.name}.`);
        } else {
          notes.push(resolved.message);
        }
      }

      return {
        handled: true,
        items: next,
        message: notes.join(' ') || 'Actualicé tu carrito.',
      };
    }

    if (isCartSetQuantityIntent(userText)) {
      const req = parseCartSetQuantity(userText);
      if (!req) return { handled: false, items, message: '' };

      const existing = CartService.findByTarget(items, req.target);
      if (!existing) {
        return {
          handled: true,
          items,
          message: `No encontré "${describeCartTarget(req.target)}" en tu carrito.`,
        };
      }

      const next = CartService.setQuantityByTarget(items, req.target, req.quantity);
      return {
        handled: true,
        items: next,
        message: `Listo, dejé ${req.quantity} de ${existing.name}.`,
      };
    }

    if (isCartRemoveIntent(userText)) {
      const clauses = splitCartEditClauses(userText);
      const req = parseCartRemove(clauses.reject);

      if (!hasProductReference(req.target)) {
        return {
          handled: true,
          items,
          message: 'Indica qué producto quieres quitar (nombre, variante o SKU). Ej: "quitar 2 balines #3" o "eliminar anillo talla 6".',
        };
      }

      const removed = CartService.removeByTarget(
        items,
        req.target,
        req.removeAll ? 99 : req.target.quantity,
        req.removeAll
      );
      if (removed.removedQty <= 0) {
        return {
          handled: true,
          items,
          message: `No encontré "${describeCartTarget(req.target)}" en tu carrito.`,
        };
      }

      const label = removed.removedNames.length === 1 ? removed.removedNames[0] : removed.removedNames.join(', ');
      const notes = [
        removed.removedQty < req.target.quantity && !req.removeAll
          ? `Solo había ${removed.removedQty}; ${removed.removedQty === 1 ? 'lo quité' : 'los quité'}.`
          : `Quité ${removed.removedQty} de ${label}.`,
      ];

      let next = removed.items;
      if (clauses.want) {
        const adjusted = await this.applyCartWantClause(tenantId, clauses.want, next);
        next = adjusted.items;
        if (adjusted.note) notes.push(adjusted.note);
      }

      return { handled: true, items: next, message: notes.join(' ') };
    }

    if (isCartIncrementIntent(userText)) {
      const adjusted = await this.applyCartWantClause(tenantId, userText, items);
      return { handled: true, items: adjusted.items, message: adjusted.note || 'Actualicé tu carrito.' };
    }

    return { handled: false, items, message: '' };
  }

  /** Suma 1 a un ítem del carrito ("otra unidad de X") o lo agrega si aún no está. */
  private async applyCartWantClause(
    tenantId: string,
    wantText: string,
    items: PendingCartItem[]
  ): Promise<{ items: PendingCartItem[]; note: string }> {
    const increment = isCartIncrementPhrase(wantText);
    const target = extractCartTarget(wantText, increment ? 1 : extractSpokenQuantity(wantText, 1));
    const existing = CartService.findByTarget(items, target);

    if (existing && increment) {
      const next = CartService.setQuantityByTarget(items, target, existing.quantity + 1);
      return { items: next, note: `Dejé ${existing.quantity + 1} de ${existing.name}.` };
    }

    if (existing && !increment) {
      const next = CartService.setQuantityByTarget(items, target, target.quantity);
      return { items: next, note: `Dejé ${target.quantity} de ${existing.name}.` };
    }

    const query = buildProductQueryFromTarget(target);
    if (!query.trim()) {
      return { items, note: 'Dime el *ID* o el nombre de lo que quieres agregar.' };
    }

    const resolved = await this.resolveSelectionFromTextInner(tenantId, query, target.quantity, {
      cartItems: items,
    });
    if (resolved.ok && resolved.item) {
      const next = CartService.merge(items, [{ ...resolved.item, quantity: target.quantity }]);
      return { items: next, note: `Agregué ${target.quantity} de ${resolved.item.name}.` };
    }

    return { items, note: resolved.message };
  }

  /**
   * "Solo quiero X y Y": el carrito queda exactamente con eso. Si no se identifica qué
   * quiere conservar, el carrito no se toca y se le pide precisión: perder productos por
   * una interpretación dudosa es mucho peor que preguntar.
   */
  private async applyCartKeepOnly(
    tenantId: string,
    userText: string,
    items: PendingCartItem[],
    lastAddedSkus?: string[]
  ): Promise<{ handled: boolean; items: PendingCartItem[]; message: string }> {
    const parsed = parseCartKeepOnly(userText);
    if (!parsed) return { handled: false, items, message: '' };

    // "solo los dos que te dije": lo agregado en el turno anterior es la referencia fiable.
    if (parsed.previousReference) {
      const wanted = new Set(lastAddedSkus ?? []);
      const kept = items.filter((item) => wanted.has(item.sku));
      if (kept.length) {
        return {
          handled: true,
          items: kept,
          message: `${EMOJI.check} Dejé tu carrito solo con lo que me pediste:`,
        };
      }
      return { handled: true, items, message: this.buildKeepOnlyHelp(items) };
    }

    const resolved = await this.resolveSelectionsFromText(tenantId, parsed.wanted, 1);
    if (resolved.ok && resolved.items?.length) {
      const kept = CartService.merge(undefined, resolved.items);
      const note = resolved.message ? ` ${resolved.message}` : '';
      return {
        handled: true,
        items: kept,
        message: `${EMOJI.check} Perfecto, dejé tu carrito solo con lo que me pediste.${note}`,
      };
    }

    if (!items.length) return { handled: false, items, message: '' };
    return { handled: true, items, message: this.buildKeepOnlyHelp(items) };
  }

  private buildKeepOnlyHelp(items: PendingCartItem[]): string {
    const lines = items.map((item, index) => `${index + 1}. ${item.name} — *${item.sku}*`);
    return [
      'Quiero asegurarme de no borrar algo por error 🙌 Este es tu carrito ahora:',
      '',
      ...lines,
      '',
      'Dime los *ID* que quieres conservar (por ejemplo: «solo quiero ' +
        `${items[0]?.sku ?? 'ABC-01'}») y dejo el carrito con eso.`,
    ].join('\n');
  }

  /** Resuelve selección en texto libre → producto/variación WooCommerce por SKU (cualquier catálogo). */
  async resolveSelectionFromText(
    tenantId: string,
    userText: string,
    quantity = 1,
    context?: { cartItems?: PendingCartItem[] }
  ): Promise<ProductResolution> {
    const batch = await this.resolveSelectionsFromText(tenantId, userText, quantity, context);
    if (!batch.ok || !batch.items?.length) {
      return {
        ok: false,
        message: batch.message,
        needsChoice: batch.needsChoice,
        options: batch.options,
      };
    }
    return { ok: true, message: batch.message, item: batch.items[0] };
  }

  /** Resuelve una o varias selecciones (ej. "45cm y otra de 50cm"). */
  async resolveSelectionsFromText(
    tenantId: string,
    userText: string,
    quantity = 1,
    context?: { cartItems?: PendingCartItem[] }
  ): Promise<ProductResolutionBatch> {
    try {
      const trimmed = normalizeUserTypos(userText.trim());

      if (
        isCartCorrectionIntent(trimmed) ||
        isCartRemoveIntent(trimmed) ||
        isCartClearIntent(trimmed) ||
        isCartSetQuantityIntent(trimmed) ||
        isCartIncrementIntent(trimmed)
      ) {
        return { ok: false, message: 'Operación de carrito no aplicable aquí.' };
      }

      const multiProducts = parseMultiProductSelection(trimmed);
      if (multiProducts && multiProducts.length >= 2) {
        const items: OrderItem[] = [];
        const errors: string[] = [];

        for (const segment of multiProducts) {
          const segmentQuantity = extractSpokenQuantity(segment, quantity);
          const result = await this.resolveSelectionFromTextInner(tenantId, segment, segmentQuantity, {
            cartItems: [...(context?.cartItems ?? []), ...items],
          });
          if (!result.ok || !result.item) {
            errors.push(result.message);
            continue;
          }

          // El mismo ID en dos segmentos ("dos de X y una de X") suma unidades.
          const existing = items.find((row) => row.sku === result.item!.sku);
          if (existing) existing.quantity += result.item.quantity;
          else items.push(result.item);
        }

        if (!items.length) {
          return {
            ok: false,
            message:
              errors[0] ??
              'No pude identificar los productos en la tienda. Solo agrego productos publicados en WooCommerce.',
          };
        }

        const note =
          errors.length ?
            ` ${errors.join(' ')}`
          : '';
        return { ok: true, message: note.trim(), items };
      }

      const multi = parseMultiVariantSelection(trimmed);
      if (multi && multi.variantHints.length >= 2) {
        const items: OrderItem[] = [];
        for (const hint of multi.variantHints) {
          const syntheticText = `${multi.baseQuery} de ${hint}`;
          const result = await this.resolveSelectionFromTextInner(tenantId, syntheticText, quantity, context);
          if (!result.ok || !result.item) {
            if (items.length) {
              return {
                ok: false,
                message: `${result.message} (Se agregaron ${items.length} producto(s) antes del error.)`,
                items,
              };
            }
            return { ok: false, message: result.message };
          }
          const duplicate = items.some((row) => row.sku === result.item!.sku);
          if (!duplicate) items.push(result.item);
        }

        if (!items.length) {
          return { ok: false, message: 'No pude identificar los productos solicitados.' };
        }

        return { ok: true, message: '', items };
      }

      const single = await this.resolveSelectionFromTextInner(tenantId, trimmed, quantity, context);
      return {
        ok: single.ok,
        message: single.message,
        items: single.item ? [single.item] : undefined,
        needsChoice: single.needsChoice,
        options: single.options,
      };
    } catch (err) {
      return { ok: false, message: this.formatStoreError(err) };
    }
  }

  private async resolveSelectionFromTextInner(
    tenantId: string,
    userText: string,
    quantity = 1,
    context?: { cartItems?: PendingCartItem[] }
  ): Promise<ProductResolution> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return { ok: false, message: 'WooCommerce no conectado.' };
    }

    const trimmed = userText.trim();
    // "dos unidades de CAD-ORO-45": la cantidad puede venir en palabras.
    const qty = extractSpokenQuantity(trimmed, quantity);

    // El ID puede venir dentro de la frase: "quiero dos unidades de CAD-ORO-45".
    const explicitSku = looksLikeSku(trimmed) ? trimmed : extractExplicitSkus(trimmed)[0];
    if (explicitSku) {
      const bySku = await this.buildOrderItemBySku(tenantId, explicitSku, qty);
      if (bySku.ok) return bySku;
    }

    const parsed = parseProductSelectionQuery(trimmed);
    const variantHint = parsed.variantHint ?? extractVariantHint(trimmed);

    const ragMatch = await this.resolveSkuFromRag(tenantId, trimmed, variantHint);
    if (ragMatch) {
      const fromRag = await this.buildOrderItemBySku(tenantId, ragMatch.sku, qty);
      if (fromRag.ok) return fromRag;
    }

    const cartHasItems = !!context?.cartItems?.length;
    let siblingAttempt: ProductResolution | null = null;

    const anchor = cartHasItems ? context!.cartItems![context!.cartItems!.length - 1] : undefined;
    const anchorBase = anchor ? normalizeProductText(anchor.name.split(' - ')[0] || anchor.name) : '';
    const queryNorm = normalizeProductText(parsed.productQuery);
    const sameProductFamily =
      !queryNorm ||
      tokenizeProductQuery(parsed.productQuery).every((token) => anchorBase.includes(token)) ||
      anchorBase.split(' ').filter((t) => t.length >= 4).every((t) => queryNorm.includes(t));

    const useSiblingPath =
      cartHasItems &&
      anchor &&
      (isSameProductReference(trimmed) ||
        (isCartSiblingVariantIntent(trimmed, cartHasItems) && sameProductFamily));

    if (useSiblingPath) {
      if (variantHint && cartItemMatchesVariantHint(anchor, variantHint)) {
        return await this.buildOrderItemBySku(tenantId, anchor.sku, qty);
      }

      if (!variantHint && isSameProductReference(trimmed)) {
        return await this.buildOrderItemBySku(tenantId, anchor.sku, qty);
      }

      if (variantHint) {
        siblingAttempt = await this.resolveSiblingVariation(tenantId, anchor, variantHint, qty);
        if (siblingAttempt.ok) return siblingAttempt;

        const siblingSearch = await this.resolveFromCatalogSearch(
          config,
          tenantId,
          `${anchor.name.split(' - ')[0]} ${variantHint}`,
          userText,
          variantHint,
          qty
        );
        if (siblingSearch.ok) return siblingSearch;
      }
    }

    // El `search` de WooCommerce coincide con la frase literal, así que descarta plurales y
    // descripciones de varias palabras. El índice local puntúa todo el catálogo por tokens.
    const fromIndex = await this.resolveFromCatalogIndex(config, tenantId, trimmed, variantHint, qty);
    if (fromIndex) return fromIndex;

    const searchQuery = this.buildSearchQuery(trimmed, parsed.productQuery, context?.cartItems);
    const products = await this.searchProductsWithFallback(config, searchQuery);

    if (!products.length) {
      const catalogFallback = await this.resolveFromCatalogSearch(
        config,
        tenantId,
        searchQuery,
        userText,
        variantHint,
        qty
      );
      if (catalogFallback.ok) return catalogFallback;

      if (siblingAttempt?.ok) return siblingAttempt;

      if (useSiblingPath && anchor) {
        if (!variantHint || cartItemMatchesVariantHint(anchor, variantHint)) {
          return await this.buildOrderItemBySku(tenantId, anchor.sku, qty);
        }
      }

      if (siblingAttempt && !siblingAttempt.ok) {
        return siblingAttempt;
      }
      return {
        ok: false,
        message: `No encontré "${userText}" en la tienda WooCommerce. Solo puedo agregar productos publicados en la tienda online.`,
      };
    }

    let bestVariation: MassiBotVariation | null = null;
    let bestParentId = 0;
    let bestScore = 0;

    for (const product of products.slice(0, 5)) {
      if (product.type === 'variable') {
        try {
          const variations = await this.loadVariations(config, product);
          for (const variation of variations) {
            const score = this.scoreVariationMatch(variation, product.name, userText, variantHint);
            if (score > bestScore) {
              bestScore = score;
              bestVariation = variation;
              bestParentId = product.id;
            }
          }
        } catch {
          continue;
        }
      } else if (product.sku) {
        const score = this.scoreSimpleProductMatch(product.name, userText);
        if (score > bestScore) {
          bestScore = score;
          bestVariation = {
            id: product.id,
            parentId: product.id,
            name: product.name,
            sku: product.sku,
            price: product.price,
            stockStatus: product.stockStatus,
            stockQuantity: product.stockQuantity,
            attributes: [],
          };
          bestParentId = product.id;
        }
      }
    }

    const minScore = variantHint ? 6 : 8;
    if (!bestVariation || bestScore < minScore) {
      return {
        ok: false,
        message: variantHint
          ? `No encontré una variación que coincida con "${variantHint}" para "${parsed.productQuery}".`
          : `No pude identificar el producto exacto en "${userText}". Indica nombre, variante o SKU.`,
      };
    }

    if (!bestVariation.sku?.trim()) {
      const skuFromStore = await this.resolveSkuForVariation(config, bestVariation);
      if (skuFromStore) bestVariation = { ...bestVariation, sku: skuFromStore };
    }

    if (!bestVariation.sku?.trim()) {
      return {
        ok: false,
        message: `Encontré "${bestVariation.name}" pero no tiene SKU en WooCommerce. Asigna SKU en la tienda.`,
      };
    }

    const itemResult = await this.buildOrderItemBySku(tenantId, bestVariation.sku, qty);
    if (!itemResult.ok || !itemResult.item) return itemResult;

    if (bestVariation.id !== bestParentId && !itemResult.item.variationId) {
      itemResult.item.variationId = bestVariation.id;
      itemResult.item.productId = bestParentId;
    }

    return itemResult;
  }

  /**
   * Resuelve una descripción en lenguaje natural contra el índice local del catálogo.
   * Devuelve `null` cuando no hay candidatos, para que sigan los caminos de búsqueda WC.
   */
  private async resolveFromCatalogIndex(
    config: WooCommerceConfigData,
    tenantId: string,
    userText: string,
    variantHint: string | undefined,
    quantity: number
  ): Promise<ProductResolution | null> {
    const parsed = parseProductSelectionQuery(normalizeUserTypos(userText));
    const query = parsed.productQuery?.trim() || userText;

    const matches = await this.catalogIndex.search(
      tenantId,
      config,
      query,
      variantHint,
      PRODUCT_LIST_MAX_LINES
    );
    if (!matches.length) return null;

    if (!isDecisiveMatch(matches)) {
      const products = matches.map((match) => match.entry.product);
      return {
        ok: false,
        needsChoice: true,
        message: buildAmbiguousProductMessage(products),
        options: products.map(toOfferedOptionFromProduct),
      };
    }

    const product = matches[0]!.entry.product;

    if (product.type === 'variable') {
      const variations = await this.loadVariations(config, product);
      if (!variations.length) return null;

      const chosen =
        (variantHint ? this.matchVariation(variations, variantHint) : undefined) ??
        (variations.length === 1 ? variations[0] : undefined);

      if (!chosen) {
        const listed = await this.describeProductOptions(config, product, variantHint);
        return {
          ok: false,
          needsChoice: listed.ok,
          message: listed.message,
          options: listed.options,
        };
      }

      const sku = chosen.sku?.trim() || (await this.resolveSkuForVariation(config, chosen)) || '';
      if (!sku) {
        return {
          ok: false,
          message: `Encontré "${chosen.name}" pero no tiene ID asignado en la tienda.`,
        };
      }

      return await this.buildOrderItemBySku(tenantId, sku, quantity);
    }

    const sku = product.sku?.trim();
    if (!sku) return null;

    return await this.buildOrderItemBySku(tenantId, sku, quantity);
  }

  /** Misma familia de producto que el carrito, otra variación (ej. 50cm → 60cm). */
  private async resolveSiblingVariation(
    tenantId: string,
    anchor: PendingCartItem,
    variantHint: string,
    quantity: number
  ): Promise<ProductResolution> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return { ok: false, message: 'No se pudo resolver variación desde el carrito.' };
    }

    try {
      const variations = await this.loadVariations(config, {
        id: anchor.productId,
        name: anchor.name,
      });
      const matched = this.matchVariation(variations, variantHint);
      if (!matched) {
        return {
          ok: false,
          message: `No encontré la variación "${variantHint}" para ${anchor.name.split(' - ')[0] || 'el producto'}.`,
        };
      }

      let sku = matched.sku?.trim();
      if (!sku) {
        sku = (await this.resolveSkuForVariation(config, matched)) ?? '';
      }
      if (!sku) {
        return {
          ok: false,
          message: `Encontré "${matched.name}" pero no tiene SKU en WooCommerce. Asigna SKU en la tienda.`,
        };
      }

      return await this.buildOrderItemBySku(tenantId, sku, quantity);
    } catch (err) {
      if (err instanceof DomainError && err.code === 'WOOCOMMERCE_ERROR') {
        return { ok: false, message: this.formatStoreError(err) };
      }
      return { ok: false, message: 'Error al consultar variaciones del producto en carrito.' };
    }
  }

  /** MASSI Bot a veces devuelve variaciones sin SKU; WooCommerce REST sí lo tiene. */
  private async resolveSkuForVariation(
    config: WooCommerceConfigData,
    variation: MassiBotVariation
  ): Promise<string | null> {
    if (variation.sku?.trim()) return variation.sku.trim();
    try {
      const product = await this.wcService.getProductById(config, variation.id);
      return product?.sku?.trim() || null;
    } catch {
      return null;
    }
  }

  private formatStoreError(err: unknown): string {
    if (err instanceof DomainError && err.code === 'WOOCOMMERCE_ERROR') {
      if (/error 50[234]/.test(err.message)) {
        return 'No pude conectar con la tienda en este momento (error temporal). Intenta de nuevo en unos segundos.';
      }
      return 'No pude consultar la tienda. Intenta de nuevo en un momento.';
    }
    if (err instanceof DomainError && err.code === 'WOOCOMMERCE_NOT_CONFIGURED') {
      return 'La tienda WooCommerce no está configurada.';
    }
    if (err instanceof DomainError && err.code === 'MASSI_BOT_ERROR') {
      if (/error 50[234]/.test(err.message)) {
        return 'No pude conectar con la tienda en este momento (error temporal). Intenta de nuevo en unos segundos.';
      }
      return 'No pude consultar las opciones de ese producto. Intenta de nuevo en un momento.';
    }
    return 'Ocurrió un error al consultar la tienda. Intenta de nuevo.';
  }

  private buildSearchQuery(userText: string, parsedQuery: string, cartItems?: PendingCartItem[]): string {
    const cleaned = parsedQuery
      .trim()
      .replace(/^(agregar|a[nñ]adir)\s+/i, '')
      .replace(/\s+de\s*$/i, '')
      .trim();

    const tokens = tokenizeProductQuery(cleaned);
    if (tokens.length >= 2) {
      return tokens.join(' ');
    }
    if (tokens.length === 1 && tokens[0].length >= 3) {
      return tokens[0];
    }

    const fallbackTokens = tokenizeProductQuery(
      userText.replace(/^(me gustar[ií]a|quisiera|quiero|busco|necesito|dame|comprar|tambi[eé]n|agregar|a[nñ]adir)\s+/gi, '')
    );
    if (fallbackTokens.length >= 2) {
      return fallbackTokens.slice(0, 5).join(' ');
    }

    if (cartItems?.length) {
      const anchor = cartItems[cartItems.length - 1];
      const baseName = anchor.name.split(' - ')[0]?.trim() || anchor.name;
      if (baseName.length >= 3) return baseName;
    }

    return userText;
  }

  private async resolveFromCatalogSearch(
    config: WooCommerceConfigData,
    tenantId: string,
    searchQuery: string,
    userText: string,
    variantHint: string | undefined,
    qty: number
  ): Promise<ProductResolution> {
    const query = searchQuery.trim();
    if (!query) {
      return { ok: false, message: 'Consulta de producto vacía.' };
    }

    const products = await this.searchProductsWithFallback(config, query);
    if (!products.length) {
      return {
        ok: false,
        message: `No encontré "${userText}" en la tienda WooCommerce. Solo puedo agregar productos publicados en la tienda online.`,
      };
    }

    let bestVariation: MassiBotVariation | null = null;
    let bestParentId = 0;
    let bestScore = 0;

    for (const product of products.slice(0, 5)) {
      if (product.type === 'variable') {
        try {
          const variations = await this.loadVariations(config, product);
          for (const variation of variations) {
            const score = this.scoreVariationMatch(variation, product.name, userText, variantHint);
            if (score > bestScore) {
              bestScore = score;
              bestVariation = variation;
              bestParentId = product.id;
            }
          }
        } catch {
          continue;
        }
      } else if (product.sku) {
        const score = this.scoreSimpleProductMatch(product.name, userText);
        if (score > bestScore) {
          bestScore = score;
          bestVariation = {
            id: product.id,
            parentId: product.id,
            name: product.name,
            sku: product.sku,
            price: product.price,
            stockStatus: product.stockStatus,
            stockQuantity: product.stockQuantity,
            attributes: [],
          };
          bestParentId = product.id;
        }
      }
    }

    const minScore = variantHint ? 6 : 8;
    if (!bestVariation || bestScore < minScore) {
      return {
        ok: false,
        message: variantHint
          ? `No encontré una variación que coincida con "${variantHint}".`
          : `No pude identificar el producto exacto en "${userText}". Indica SKU si lo tienes.`,
      };
    }

    if (!bestVariation.sku?.trim()) {
      const skuFromStore = await this.resolveSkuForVariation(config, bestVariation);
      if (skuFromStore) bestVariation = { ...bestVariation, sku: skuFromStore };
    }

    if (!bestVariation.sku?.trim()) {
      return { ok: false, message: `Encontré "${bestVariation.name}" pero no tiene SKU en WooCommerce.` };
    }

    const itemResult = await this.buildOrderItemBySku(tenantId, bestVariation.sku, qty);
    if (!itemResult.ok || !itemResult.item) return itemResult;

    if (bestVariation.id !== bestParentId && !itemResult.item.variationId) {
      itemResult.item.variationId = bestVariation.id;
      itemResult.item.productId = bestParentId;
    }

    return itemResult;
  }

  private scoreVariationMatch(
    variation: MassiBotVariation,
    parentName: string,
    userText: string,
    variantHint?: string
  ): number {
    if (variantHint && this.matchVariation([variation], variantHint)) return 20;
    if (this.matchVariation([variation], userText)) return 15;

    const blob = normalizeProductText(
      `${parentName} ${variation.name} ${variation.attributes.map((attribute) => `${attribute.name} ${attribute.value}`).join(' ')}`
    );
    let score = 0;

    if (variantHint) {
      const compactHint = variantHint.replace(/\s+/g, '');
      if (blob.replace(/\s+/g, '').includes(compactHint)) score += 8;
    }

    const tokens = tokenizeProductQuery(userText);
    if (tokens.length === 0) return score;

    const matched = tokens.filter((token) => blob.includes(token)).length;
    score += matched * 2;

    if (matched / tokens.length >= 0.5) score += 4;
    if (matched === tokens.length && tokens.length >= 2) score += 3;

    return score;
  }

  private scoreSimpleProductMatch(productName: string, userText: string): number {
    const name = normalizeProductText(productName);
    const tokens = tokenizeProductQuery(userText);
    if (!tokens.length) return 0;

    const matched = tokens.filter((token) => name.includes(token)).length;
    return matched * 2 + (matched / tokens.length >= 0.5 ? 4 : 0);
  }

  private isResolvedAvailable(
    resolved: { stockStatus: string; stockQuantity: number | null },
    quantity: number
  ): boolean {
    if (resolved.stockStatus !== 'instock') return false;
    if (resolved.stockQuantity == null) return true;
    return resolved.stockQuantity >= quantity;
  }

  private async resolveProductBySku(
    config: WooCommerceConfigData,
    sku: string
  ): Promise<{
    productId: number;
    variationId?: number;
    sku: string;
    name: string;
    price: string;
    stockStatus: string;
    stockQuantity: number | null;
  } | null> {
    const normalizedSku = sku.trim();
    if (!normalizedSku) return null;

    if (this.massiBot.isConfigured(config)) {
      try {
        const item = await this.massiBot.findProductBySku(config, normalizedSku);
        if (item) {
          const isVariation = item.isVariation ?? item.id !== item.parentId;
          return {
            productId: item.parentId,
            variationId: isVariation ? item.id : undefined,
            sku: item.sku || normalizedSku,
            name: item.name,
            price: item.price,
            stockStatus: item.stockStatus,
            stockQuantity: item.stockQuantity,
          };
        }
      } catch {
        // fallback WooCommerce REST
      }
    }

    const product = await this.wcService.getProductBySku(config, normalizedSku);
    if (!product) return null;

    return {
      productId: product.id,
      sku: product.sku || normalizedSku,
      name: product.name,
      price: product.price,
      stockStatus: product.stockStatus,
      stockQuantity: product.stockQuantity,
    };
  }

  private stockResultFromResolved(
    resolved: {
      productId: number;
      variationId?: number;
      sku: string;
      name: string;
      price: string;
      stockStatus: string;
      stockQuantity: number | null;
    },
    quantity: number
  ): StockCheckResult {
    const available =
      resolved.stockStatus === 'instock' &&
      (resolved.stockQuantity == null || resolved.stockQuantity >= quantity);

    return {
      available,
      sku: resolved.sku,
      name: resolved.name,
      quantity,
      stockStatus: resolved.stockStatus,
      stockQuantity: resolved.stockQuantity,
      message: available
        ? `Disponible: ${resolved.name} | SKU: ${resolved.sku} | productId=${resolved.productId}${
            resolved.variationId ? `, variationId=${resolved.variationId}` : ''
          } | cantidad ${quantity} | precio ${resolved.price}. Usa este SKU en preparar_pago.`
        : `Sin stock para ${resolved.name} (SKU ${resolved.sku}). Estado: ${resolved.stockStatus}.`,
    };
  }

  private formatResolvedSkuProduct(resolved: {
    productId: number;
    variationId?: number;
    sku: string;
    name: string;
    price: string;
    stockStatus: string;
    stockQuantity: number | null;
  }): string {
    const stock =
      resolved.stockQuantity != null
        ? `${resolved.stockStatus} (${resolved.stockQuantity} uds.)`
        : resolved.stockStatus;
    return [
      'Producto encontrado por SKU:',
      `- ${resolved.name}`,
      `  SKU: ${resolved.sku}`,
      `  productId=${resolved.productId}${resolved.variationId ? ` | variationId=${resolved.variationId}` : ''}`,
      `  Precio: ${resolved.price} | Stock: ${stock}`,
      'Usa verificar_stock(sku) y preparar_pago con este SKU exacto.',
    ].join('\n');
  }

  private async searchProductsWithFallback(config: WooCommerceConfigData, query: string): Promise<WooCommerceProduct[]> {
    const attempts = this.buildSearchAttempts(query);
    let lastError: unknown;

    for (const attempt of attempts) {
      try {
        const found = await this.wcService.searchProducts(config, attempt);
        if (found.length) return found;
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError) throw lastError;
    return [];
  }

  private buildSearchAttempts(query: string): string[] {
    const q = query.trim();
    if (!q) return [];

    const attempts: string[] = [];
    const add = (value: string) => {
      const trimmed = value.trim().replace(/\s+/g, ' ');
      if (trimmed && !attempts.includes(trimmed)) attempts.push(trimmed);
    };

    add(q);

    const withoutIntent = q
      .replace(
        /^(me gustar[ií]a|quisiera|quiero|busco|necesito|dame|comprar|llevar|tomar|pedir|solicito|agregar|a[nñ]adir|agreagar|una?\s+|un\s+|la\s+|el\s+|los\s+|las\s+)/gi,
        ''
      )
      .replace(/\s+de\s*$/i, '')
      .trim();
    add(withoutIntent);

    const withoutVariant = q.replace(VARIANT_STRIP_PATTERN, '').replace(/\s+/g, ' ').trim();
    add(withoutVariant);

    if (withoutIntent !== q) {
      add(withoutIntent.replace(VARIANT_STRIP_PATTERN, '').replace(/\s+/g, ' ').trim());
    }

    const keywords = tokenizeProductQuery(withoutVariant);
    if (keywords.length >= 2) {
      add(keywords.slice(0, 5).join(' '));
    }
    if (keywords.length >= 1) {
      add(keywords.slice(0, 3).join(' '));
    }

    return attempts;
  }

  private parseProductQuery(query: string): { productQuery: string; variantHint?: string } {
    return parseProductSelectionQuery(query);
  }

  private matchVariation(variations: MassiBotVariation[], hint: string) {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/\s+/g, ' ')
        .trim();

    const compact = (s: string) => norm(s).replace(/\s+/g, '');

    const h = norm(hint);
    const hc = compact(hint);
    if (!h) return undefined;

    const scored = variations.map((v) => {
      const name = norm(v.name);
      const attrs = norm(v.attributes.map((a) => `${a.name} ${a.value}`).join(' '));
      const blob = `${name} ${attrs}`;
      const blobCompact = compact(blob);
      let score = 0;
      if (blob.includes(h)) score += 10;
      if (name.includes(h)) score += 5;
      if (hc && blobCompact.includes(hc)) score += 8;
      for (const token of h.split(' ').filter((t) => t.length > 1)) {
        if (blob.includes(token)) score += 2;
      }
      const sizeToken = hc.match(/\d+(?:cm|mm)?/);
      if (sizeToken && blobCompact.includes(sizeToken[0])) score += 6;
      return { v, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    return best && best.score >= 4 ? best.v : undefined;
  }

  private formatVariationLine(v: MassiBotVariation): string {
    const attrs = v.attributes.map((a) => `${a.name}: ${a.value}`).join(', ');
    const stock =
      v.stockQuantity != null ? `${v.stockStatus} (${v.stockQuantity} uds.)` : v.stockStatus;
    return `SKU: ${v.sku || 'SIN SKU'} | ${v.name} | variationId=${v.id} | productId=${v.parentId} | Precio: ${v.price} | ${attrs || 'sin atributos'} | Stock: ${stock}`;
  }

  private isVariationAvailable(
    variation: { stockStatus: string; stockQuantity: number | null },
    quantity: number
  ): boolean {
    if (variation.stockStatus !== 'instock') return false;
    if (variation.stockQuantity == null) return true;
    return variation.stockQuantity >= quantity;
  }

  private isProductAvailable(product: WooCommerceProduct, quantity: number): boolean {
    if (product.stockStatus !== 'instock') return false;
    if (product.stockQuantity == null) return true;
    return product.stockQuantity >= quantity;
  }

  private formatProduct(p: WooCommerceProduct): string {
    const stock =
      p.stockQuantity != null ? `${p.stockStatus} (${p.stockQuantity} uds.)` : p.stockStatus;
    const typeHint = p.type === 'variable' ? ' | Tipo: variable (cada variación tiene SKU propio)' : '';
    return `- ${p.name} | SKU: ${p.sku || 'SIN SKU — asignar en WooCommerce'} | productId=${p.id} | Precio: ${p.price} | Stock: ${stock}${typeHint}`;
  }
}
