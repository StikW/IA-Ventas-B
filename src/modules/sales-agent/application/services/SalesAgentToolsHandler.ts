import { inject, injectable } from 'tsyringe';
import { RagSearchService } from '../../../knowledge/application/services/RagSearchService';
import { OrderItem } from '../../../commerce/domain/entities/Order.types';
import { IMassiBotService } from '../../../massi-bot/domain/IMassiBotService';
import { IWooCommerceConfigRepository, IWooCommerceService, WooCommerceProduct } from '../../../woocommerce/domain/IWooCommerceService';
import { SalesContext } from '../../domain/IChatSessionRepository';

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

    const products = await this.wcService.searchProducts(config, query);
    if (!products.length) return `No se encontraron productos en la tienda para "${query}".`;

    const lines: string[] = [];
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
    const variantHint = input.variantHint?.trim();
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

    if (!productId && input.productName?.trim()) {
      const found = await this.wcService.searchProducts(config, input.productName.trim());
      if (found[0]) productId = found[0].id;
    }

    if (productId && variantHint && !variationId && this.massiBot.isConfigured(config)) {
      try {
        const variations = await this.massiBot.getProductVariations(config, productId);
        const matched = this.matchVariation(variations, variantHint);
        if (matched) variationId = matched.id;
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
            ? `Disponible: ${variation.name} (variación ID ${variation.id}), cantidad ${quantity}, precio ${variation.price}. productId=${productId}, variationId=${variation.id}.`
            : `Sin stock para ${variation.name}. Estado: ${variation.stockStatus}.`,
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
            `  · ${v.name} | variationId=${v.id} | precio ${v.price} | stock ${v.stockStatus}${
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
            `Producto encontrado: ${product.name} (productId=${productId}). Es variable — muestra estas opciones al cliente:`,
            ...lines,
            variantHint
              ? `No encontré variación que coincida con "${variantHint}". Pide aclarar o elige variationId de la lista.`
              : 'Cuando el cliente elija, usa verificar_stock con product_id y variation_id (o variante="50 cm").',
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
          ? `Disponible: ${product.name} (productId=${product.id}), cantidad ${quantity}, precio ${product.price}.`
          : `Sin stock suficiente para ${product.name}. Estado: ${product.stockStatus}.`,
      };
    }

    if (sku?.trim()) {
      const product = await this.wcService.getProductBySku(config, sku.trim());
      if (!product) {
        return {
          available: false,
          sku,
          name: sku,
          quantity,
          stockStatus: 'notfound',
          stockQuantity: null,
          message: `Producto con SKU "${sku}" no encontrado. Usa product_id de buscar_productos_tienda si es MASSI.`,
        };
      }
      if (product.type === 'variable') {
        return this.checkStock(tenantId, { productId: product.id, quantity });
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
          ? `Disponible: ${product.name} (SKU ${product.sku}, productId=${product.id}), cantidad ${quantity}, precio ${product.price}.`
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
      message: 'Indica product_id (de buscar_productos_tienda) o sku para verificar stock.',
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
        return `- ${v.name} | variationId=${v.id} | productId=${v.parentId} | Precio: ${v.price} | ${attrs || 'sin atributos'} | Stock: ${stock}`;
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

  private matchVariation(
    variations: Array<{ id: number; name: string; attributes: Array<{ name: string; value: string }> }>,
    hint: string
  ) {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/\s+/g, ' ')
        .trim();

    const h = norm(hint);
    if (!h) return undefined;

    const scored = variations.map((v) => {
      const name = norm(v.name);
      const attrs = norm(v.attributes.map((a) => `${a.name} ${a.value}`).join(' '));
      const blob = `${name} ${attrs}`;
      let score = 0;
      if (blob.includes(h)) score += 10;
      if (name.includes(h)) score += 5;
      for (const token of h.split(' ').filter((t) => t.length > 1)) {
        if (blob.includes(token)) score += 2;
      }
      return { v, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    return best && best.score >= 4 ? best.v : undefined;
  }

  private formatVariationLine(v: {
    id: number;
    parentId: number;
    name: string;
    price: string;
    stockStatus: string;
    stockQuantity: number | null;
    attributes: Array<{ name: string; value: string }>;
  }): string {
    const attrs = v.attributes.map((a) => `${a.name}: ${a.value}`).join(', ');
    const stock =
      v.stockQuantity != null ? `${v.stockStatus} (${v.stockQuantity} uds.)` : v.stockStatus;
    return `${v.name} | variationId=${v.id} | productId=${v.parentId} | Precio: ${v.price} | ${attrs || 'sin atributos'} | Stock: ${stock}`;
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
    const typeHint = p.type === 'variable' ? ' | Tipo: variable (usar listar_variaciones)' : '';
    return `- ${p.name} | SKU: ${p.sku || 'SIN SKU — asignar en WooCommerce'} | productId=${p.id} | Precio: ${p.price} | Stock: ${stock}${typeHint}`;
  }
}
