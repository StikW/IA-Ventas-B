import { inject, injectable } from 'tsyringe';
import { RagSearchService } from '../../../knowledge/application/services/RagSearchService';
import { OrderItem } from '../../../commerce/domain/entities/Order.types';
import { IMassiBotService, MassiBotVariation } from '../../../massi-bot/domain/IMassiBotService';
import { IWooCommerceConfigRepository, IWooCommerceService, WooCommerceConfigData, WooCommerceProduct } from '../../../woocommerce/domain/IWooCommerceService';
import { SalesContext } from '../../domain/IChatSessionRepository';
import {
  extractQuantityFromText,
  extractVariantHint,
  looksLikeSku,
  normalizeProductText,
  parseProductSelectionQuery,
  tokenizeProductQuery,
  VARIANT_STRIP_PATTERN,
} from '../../domain/productSelection.utils';

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

  async searchStoreProducts(tenantId: string, query: string): Promise<string> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) return 'WooCommerce no está conectado para este negocio.';

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

  async buildOrderItemBySku(
    tenantId: string,
    sku: string,
    quantity = 1
  ): Promise<{ ok: boolean; message: string; item?: OrderItem }> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return { ok: false, message: 'WooCommerce no conectado.' };
    }

    const resolved = await this.resolveProductBySku(config, sku.trim());
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

  /** Resuelve selección en texto libre → producto/variación WooCommerce por SKU (cualquier catálogo). */
  async resolveSelectionFromText(
    tenantId: string,
    userText: string,
    quantity = 1
  ): Promise<{ ok: boolean; message: string; item?: OrderItem }> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return { ok: false, message: 'WooCommerce no conectado.' };
    }

    const trimmed = userText.trim();
    const qty = extractQuantityFromText(trimmed, quantity);

    if (looksLikeSku(trimmed)) {
      const bySku = await this.buildOrderItemBySku(tenantId, trimmed, qty);
      if (bySku.ok) return bySku;
    }

    const parsed = parseProductSelectionQuery(trimmed);
    const variantHint = parsed.variantHint ?? extractVariantHint(trimmed);
    const products = await this.searchProductsWithFallback(config, parsed.productQuery || trimmed);

    if (!products.length) {
      return {
        ok: false,
        message: `No encontré productos en la tienda para "${userText}".`,
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
    for (const attempt of attempts) {
      const found = await this.wcService.searchProducts(config, attempt);
      if (found.length) return found;
    }
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
        /^(me gustar[ií]a|quisiera|quiero|busco|necesito|dame|comprar|llevar|tomar|pedir|solicito|una?\s+|un\s+|la\s+|el\s+|los\s+|las\s+)/gi,
        ''
      )
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
