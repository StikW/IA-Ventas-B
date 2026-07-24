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

    return products
      .map((p) => this.formatProduct(p))
      .join('\n');
  }

  async checkStock(tenantId: string, sku: string, quantity: number): Promise<StockCheckResult> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.connected) {
      return {
        available: false,
        sku,
        name: sku,
        quantity,
        stockStatus: 'unknown',
        stockQuantity: null,
        message: 'WooCommerce no conectado.',
      };
    }

    const product = await this.wcService.getProductBySku(config, sku);
    if (!product) {
      return {
        available: false,
        sku,
        name: sku,
        quantity,
        stockStatus: 'notfound',
        stockQuantity: null,
        message: `Producto con SKU "${sku}" no encontrado.`,
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
        ? `Disponible: ${product.name} (SKU ${product.sku}), cantidad ${quantity}, precio ${product.price}.`
        : `Sin stock suficiente para ${product.name} (SKU ${product.sku}). Estado: ${product.stockStatus}.`,
    };
  }

  async validateCartStock(tenantId: string, items: OrderItem[]): Promise<{ ok: boolean; message: string }> {
    const checks = await Promise.all(items.map((item) => this.checkStock(tenantId, item.sku, item.quantity)));
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

  private isProductAvailable(product: WooCommerceProduct, quantity: number): boolean {
    if (product.stockStatus !== 'instock') return false;
    if (product.stockQuantity == null) return true;
    return product.stockQuantity >= quantity;
  }

  private formatProduct(p: WooCommerceProduct): string {
    const stock =
      p.stockQuantity != null ? `${p.stockStatus} (${p.stockQuantity} uds.)` : p.stockStatus;
    return `- ${p.name} | SKU: ${p.sku || 'N/A'} | ID: ${p.id} | Precio: ${p.price} | Stock: ${stock}`;
  }
}
