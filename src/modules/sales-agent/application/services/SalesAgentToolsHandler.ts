import { inject, injectable } from 'tsyringe';
import { hasOpenAI } from '../../../../shared/infrastructure/config/env';
import { RagSearchService } from '../../../knowledge/application/services/RagSearchService';
import { OrderItem } from '../../../commerce/domain/entities/Order.types';
import { IMassiBotService, MassiBotVariation } from '../../../massi-bot/domain/IMassiBotService';
import { IWooCommerceConfigRepository, IWooCommerceService, WooCommerceConfigData, WooCommerceProduct } from '../../../woocommerce/domain/IWooCommerceService';
import { SalesContext } from '../../domain/IChatSessionRepository';
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
  parseProductSelectionQuery,
  SELECTION_NOISE_WORDS,
  tokenizeProductQuery,
  VARIANT_STRIP_PATTERN,
} from '../../domain/productSelection.utils';
import { RagCatalogMatch, resolveSkuFromRagChunks } from '../../domain/catalogRag.utils';
import { buildCheckoutFormUrl } from '../../domain/checkoutLink.utils';
import {
  buildProductQueryFromTarget,
  describeCartTarget,
  extractSpokenQuantity,
  hasProductReference,
  isCartClearIntent,
  isCartCorrectionIntent,
  isCartRemoveIntent,
  isCartSetQuantityIntent,
  parseCartCorrection,
  parseCartRemove,
  parseCartSetQuantity,
} from '../../domain/cartModification.utils';
import {
  buildProductFamilyVariantsMessage,
  formatSimpleProductLineForUser,
  formatVariationLineForUser,
} from '../../domain/productDisplay.utils';
import { BusinessProfileConfig } from '../../../tenant/domain/entities/Config.types';
import { CartService } from './CartService';

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
    @inject('IMassiBotService') private readonly massiBot: IMassiBotService
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
        if (product.type === 'variable' && this.massiBot.isConfigured(config)) {
          try {
            const variations = await this.massiBot.getProductVariations(config, product.id);
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
      if (p.type === 'variable' && this.massiBot.isConfigured(config)) {
        try {
          const variations = await this.massiBot.getProductVariations(config, p.id);
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
  async resolveProductFamilyBrowse(
    tenantId: string,
    userText: string
  ): Promise<{ ok: boolean; message: string }> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return { ok: false, message: 'WooCommerce no está conectado para este negocio.' };
    }

    const family = extractProductFamilyTerm(userText);
    if (!family) return { ok: false, message: '' };

    try {
      const parsed = parseProductSelectionQuery(normalizeUserTypos(userText));
      const variantHint = parsed.variantHint ?? extractVariantHint(userText);
      const searchQuery = (parsed.productQuery || family).trim() || family;

      const products = await this.searchProductsWithFallback(config, searchQuery);
      if (!products.length) {
        return {
          ok: false,
          message: `No encontré ${family} en la tienda en este momento.`,
        };
      }

      const parent = this.pickBestParentProduct(products, userText, family);
      if (!parent) {
        return { ok: false, message: `No encontré ${family} en la tienda en este momento.` };
      }

      if (parent.type === 'variable') {
        if (!this.massiBot.isConfigured(config)) {
          return {
            ok: false,
            message: 'Este producto tiene variaciones; configura MASSI Bot API para listarlas.',
          };
        }

        let variations = await this.massiBot.getProductVariations(config, parent.id);
        if (!variations.length) {
          return { ok: false, message: `*${parent.name}* no tiene opciones publicadas aún.` };
        }

        if (variantHint) {
          const filtered = variations.filter((variation) =>
            cartItemMatchesVariantHint({ name: variation.name, sku: variation.sku }, variantHint)
          );
          if (filtered.length) variations = filtered;
        }

        const lines = variations.slice(0, 15).map((variation) => formatVariationLineForUser(variation));
        return {
          ok: true,
          message: buildProductFamilyVariantsMessage(parent.name, lines, variantHint),
        };
      }

      return {
        ok: true,
        message: buildProductFamilyVariantsMessage(parent.name, [formatSimpleProductLineForUser(parent)]),
      };
    } catch (err) {
      return { ok: false, message: this.formatStoreError(err) };
    }
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

    if (productId && variantHint && !variationId && this.massiBot.isConfigured(config)) {
      try {
        const variations = await this.massiBot.getProductVariations(config, productId);
        const matched = this.matchVariation(variations, variantHint);
        if (matched) {
          variationId = matched.id;
          if (!sku && matched.sku) sku = matched.sku;
        }
      } catch {
        // continuar sin variationId
      }
    }

    if (variationId && productId && this.massiBot.isConfigured(config)) {
      try {
        const variations = await this.massiBot.getProductVariations(config, productId);
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

      if (product.type === 'variable' && this.massiBot.isConfigured(config)) {
        const variations = await this.massiBot.getProductVariations(config, productId);
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
    if (!this.massiBot.isConfigured(config)) {
      return 'Variaciones MASSI requieren MASSI Bot API configurada.';
    }

    const variations = await this.massiBot.getProductVariations(config, productId);
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
  ): Promise<{ ok: boolean; message: string; item?: OrderItem }> {
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
    cartItems: PendingCartItem[]
  ): Promise<{ handled: boolean; items: PendingCartItem[]; message: string }> {
    const items = cartItems ?? [];

    if (isCartClearIntent(userText)) {
      return {
        handled: true,
        items: CartService.clear(),
        message: 'Listo, vacié tu carrito. ¿Qué te gustaría pedir?',
      };
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
      const req = parseCartRemove(userText);

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
      const note =
        removed.removedQty < req.target.quantity && !req.removeAll
          ? `Solo había ${removed.removedQty}; ${removed.removedQty === 1 ? 'lo quité' : 'los quité'}.`
          : `Quité ${removed.removedQty} de ${label}.`;

      return { handled: true, items: removed.items, message: note };
    }

    return { handled: false, items, message: '' };
  }

  /** Resuelve selección en texto libre → producto/variación WooCommerce por SKU (cualquier catálogo). */
  async resolveSelectionFromText(
    tenantId: string,
    userText: string,
    quantity = 1,
    context?: { cartItems?: PendingCartItem[] }
  ): Promise<{ ok: boolean; message: string; item?: OrderItem }> {
    const batch = await this.resolveSelectionsFromText(tenantId, userText, quantity, context);
    if (!batch.ok || !batch.items?.length) {
      return { ok: false, message: batch.message };
    }
    return { ok: true, message: batch.message, item: batch.items[0] };
  }

  /** Resuelve una o varias selecciones (ej. "45cm y otra de 50cm"). */
  async resolveSelectionsFromText(
    tenantId: string,
    userText: string,
    quantity = 1,
    context?: { cartItems?: PendingCartItem[] }
  ): Promise<{ ok: boolean; message: string; items?: OrderItem[] }> {
    try {
      const trimmed = normalizeUserTypos(userText.trim());

      if (isCartCorrectionIntent(trimmed) || isCartRemoveIntent(trimmed) || isCartClearIntent(trimmed) || isCartSetQuantityIntent(trimmed)) {
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
  ): Promise<{ ok: boolean; message: string; item?: OrderItem }> {
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
    let siblingAttempt: { ok: boolean; message: string; item?: OrderItem } | null = null;

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
      if (product.type === 'variable' && this.massiBot.isConfigured(config)) {
        try {
          const variations = await this.massiBot.getProductVariations(config, product.id);
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

  /** Misma familia de producto que el carrito, otra variación (ej. 50cm → 60cm). */
  private async resolveSiblingVariation(
    tenantId: string,
    anchor: PendingCartItem,
    variantHint: string,
    quantity: number
  ): Promise<{ ok: boolean; message: string; item?: OrderItem }> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected || !this.massiBot.isConfigured(config)) {
      return { ok: false, message: 'No se pudo resolver variación desde el carrito.' };
    }

    try {
      const variations = await this.massiBot.getProductVariations(config, anchor.productId);
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
  ): Promise<{ ok: boolean; message: string; item?: OrderItem }> {
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
      if (product.type === 'variable' && this.massiBot.isConfigured(config)) {
        try {
          const variations = await this.massiBot.getProductVariations(config, product.id);
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
