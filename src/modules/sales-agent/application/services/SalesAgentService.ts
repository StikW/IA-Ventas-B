import OpenAI from 'openai';
import { inject, injectable } from 'tsyringe';
import { hasBuilderBot, hasOpenAI } from '../../../../shared/infrastructure/config/env';
import { AuditService } from '../../../../shared/infrastructure/audit/AuditService';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { IBuilderBotCloudService } from '../../../builderbot/domain/IBuilderBotCloudService';
import { BbcWebhookAgentResponse, emptyBbcWebhookResponse } from '../../../builderbot/domain/BbcWebhookAgentResponse';
import { resolveBuilderBotApiMode } from '../../../builderbot/infrastructure/builderBotApiMode';
import { normalizeBuilderBotPhone } from '../../../builderbot/infrastructure/builderBotPhone';
import { CreateOrderUseCase } from '../../../commerce/application/use-cases/OrderUseCases';
import { OrderItem } from '../../../commerce/domain/entities/Order.types';
import { IBusinessRepository } from '../../../tenant/domain/repositories/IBusinessRepository';
import { IConfigRepository } from '../../../tenant/domain/repositories/IConfigRepository';
import { ChatMessage, IChatSessionRepository, PendingCartItem, SalesContext } from '../../domain/IChatSessionRepository';
import { OpenAIChatAdapter } from '../../infrastructure/ai/OpenAIChatAdapter';
import { SalesAgentToolsHandler } from './SalesAgentToolsHandler';
import { ConversationFlowService, OutboundWhatsAppMessage } from './ConversationFlowService';
import { resolveBbcUiRoute } from '../../domain/bbcUiRoute';
import { isCartFinalizeIntent, isMenuGreeting } from '../../domain/whatsappFlow.constants';

const AGENT_ACTOR = 'system:sales-agent';

const SALES_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'buscar_en_documentos',
      description: 'Busca información de productos en documentos vectorizados del negocio. Incluye sugerencias relacionadas.',
      parameters: {
        type: 'object',
        properties: { consulta: { type: 'string', description: 'Qué busca el cliente' } },
        required: ['consulta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_productos_tienda',
      description:
        'Busca productos en WooCommerce. Preferir SKU exacto si lo conoces. Si buscas por nombre, devuelve SKUs de cada variación para usar en stock/compra.',
      parameters: {
        type: 'object',
        properties: {
          consulta: { type: 'string', description: 'SKU exacto (preferido, ej. CAD-LAZO-50) o nombre corto del producto' },
        },
        required: ['consulta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_variaciones',
      description:
        'Lista variaciones con SKU, medidas y precios de un producto variable. Usar solo si aún no tienes el SKU de la variación.',
      parameters: {
        type: 'object',
        properties: { product_id: { type: 'number', description: 'ID del producto padre en WooCommerce' } },
        required: ['product_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verificar_stock',
      description:
        'Verifica disponibilidad por SKU (obligatorio y preferido). Cada variación MASSI tiene SKU único que identifica medida/características.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'SKU exacto de la variación o producto simple (ej. CAD-LAZO-50)' },
          product_id: { type: 'number', description: 'Solo si no tienes SKU: ID del producto padre' },
          variation_id: { type: 'number' },
          variante: { type: 'string', description: 'Solo sin SKU: medida, ej. "50 cm"' },
          nombre_producto: { type: 'string', description: 'Evitar si es posible; preferir SKU' },
          cantidad: { type: 'number' },
        },
        required: ['cantidad'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_pedidos',
      description: 'Lista pedidos recientes del cliente en MASSI por su teléfono WhatsApp.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agregar_producto_por_sku',
      description:
        'Verifica stock y agrega al carrito por SKU en un solo paso. Preferir cuando el cliente elige un producto/variación ya listado. NO inicia el pago.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'SKU exacto de la variación (ej. CAD-LAZO-60)' },
          cantidad: { type: 'number', description: 'Cantidad (default 1)' },
          nombre_cliente: { type: 'string' },
        },
        required: ['sku'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agregar_al_carrito',
      description:
        'Agrega producto(s) al carrito tras verificar stock por SKU. NO inicia el pago. Después debes preguntar si desea agregar algo más.',
      parameters: {
        type: 'object',
        properties: {
          nombre_cliente: { type: 'string' },
          productos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                productId: { type: 'number' },
                variationId: { type: 'number' },
                sku: { type: 'string' },
                name: { type: 'string' },
                quantity: { type: 'number' },
                unitPrice: { type: 'number' },
              },
              required: ['productId', 'sku', 'name', 'quantity', 'unitPrice'],
            },
          },
        },
        required: ['productos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finalizar_compra',
      description:
        'Usar SOLO cuando el cliente confirma que no desea agregar más productos (ej. "eso es todo", "continuar con la compra"). Valida el carrito y muestra botones de pago.',
      parameters: {
        type: 'object',
        properties: {
          nombre_cliente: { type: 'string' },
        },
      },
    },
  },
];

export interface SalesAgentMessageInput {
  tenantId: string;
  deviceId: string;
  customerPhone: string;
  text: string;
  messageId?: string;
}

export interface SalesAgentImageInput {
  tenantId: string;
  deviceId: string;
  customerPhone: string;
  imageUrl?: string;
  caption?: string;
  messageId?: string;
}

export interface SalesAgentMessageResult {
  replied: boolean;
  reply?: string;
  reason?: string;
  bbcResponse?: BbcWebhookAgentResponse;
}

@injectable()
export class SalesAgentService {
  constructor(
    @inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository,
    @inject('IConfigRepository') private readonly configRepo: IConfigRepository,
    @inject('IBuilderBotCloudService') private readonly builderBot: IBuilderBotCloudService,
    @inject('IChatSessionRepository') private readonly chatRepo: IChatSessionRepository,
    @inject(OpenAIChatAdapter) private readonly chat: OpenAIChatAdapter,
    @inject(SalesAgentToolsHandler) private readonly tools: SalesAgentToolsHandler,
    @inject(ConversationFlowService) private readonly conversationFlow: ConversationFlowService,
    @inject(CreateOrderUseCase) private readonly createOrder: CreateOrderUseCase,
    @inject(AuditService) private readonly audit: AuditService
  ) {}

  async handleIncomingMessage(input: SalesAgentMessageInput): Promise<SalesAgentMessageResult> {
    if (!hasOpenAI) return { replied: false, reason: 'OPENAI_NOT_CONFIGURED' };
    if (!hasBuilderBot) return { replied: false, reason: 'BUILDERBOT_NOT_CONFIGURED' };

    const text = input.text.trim();
    if (!text) return { replied: false, reason: 'EMPTY_MESSAGE' };

    const business = await this.businessRepo.findById(input.tenantId);
    const businessName = business?.name ?? 'el negocio';
    const tenantConfig = await this.configRepo.findByTenantId(input.tenantId);
    const session = await this.chatRepo.find(input.tenantId, input.customerPhone);
    const history = session?.messages ?? [];
    let salesContext: SalesContext = session?.salesContext ?? { phase: 'browsing' };

    // Saludo/menú: salir de payment_select o carrito activo.
    if (isMenuGreeting(text) && (salesContext.flowStep === 'payment_select' || salesContext.flowStep === 'buying')) {
      salesContext = { phase: 'browsing' };
    }

    const flowResult = await this.conversationFlow.tryHandle({
      tenantId: input.tenantId,
      customerPhone: input.customerPhone,
      text,
      businessName,
      businessProfile: tenantConfig?.business,
      salesContext,
      historyLength: history.length,
    });

    if (flowResult) {
      const now = new Date().toISOString();
      const bbcResponse = await this.persistAndReply({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        customerPhone: input.customerPhone,
        messageId: input.messageId,
        history,
        userText: text,
        reply: flowResult.replyText,
        salesContext: flowResult.salesContext,
        outbound: flowResult.outbound,
        now,
        ragHits: 0,
      });
      return { replied: true, reply: flowResult.replyText, bbcResponse };
    }

    const systemPrompt = this.buildSystemPrompt({
      businessName,
      businessProfile: tenantConfig?.business,
      salesPhase: salesContext.phase,
      flowStep: salesContext.flowStep,
      cartItemCount: salesContext.cartItems?.length ?? 0,
    });

    let mutableContext = { ...salesContext };

    if (
      mutableContext.flowStep === 'buying' &&
      isCartFinalizeIntent(text) &&
      mutableContext.cartItems?.length
    ) {
      const finalizeReply = await this.finalizeCart(input, mutableContext);
      const now = new Date().toISOString();

      if (finalizeReply.enteredPaymentSelect) {
        const total = mutableContext.cartItems?.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
        const totalHint = total ? `Total: *$${total.toLocaleString('es-CO')}*` : undefined;
        const paymentPrompt = this.conversationFlow.buildPaymentMethodPrompt(mutableContext, totalHint);
        const bbcResponse = await this.persistAndReply({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: input.customerPhone,
          messageId: input.messageId,
          history,
          userText: text,
          reply: paymentPrompt.replyText,
          salesContext: { ...mutableContext, ...paymentPrompt.salesContext },
          outbound: paymentPrompt.outbound,
          now,
          ragHits: 0,
        });
        return { replied: true, reply: paymentPrompt.replyText, bbcResponse };
      }

      const bbcResponse = await this.persistAndReply({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        customerPhone: input.customerPhone,
        messageId: input.messageId,
        history,
        userText: text,
        reply: finalizeReply.message,
        salesContext: mutableContext,
        now,
        ragHits: 0,
      });
      return { replied: true, reply: finalizeReply.message, bbcResponse };
    }

    const reply = await this.chat.completeWithTools({
      systemPrompt,
      history,
      userMessage: text,
      tools: SALES_TOOLS,
      onToolCall: async (name, args) => this.executeTool(name, args, input, mutableContext),
    });

    const now = new Date().toISOString();

    const enteredPaymentSelect =
      mutableContext.flowStep === 'payment_select' && salesContext.flowStep !== 'payment_select';

    if (enteredPaymentSelect) {
      const total = mutableContext.cartItems?.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
      const totalHint = total ? `Total estimado: *$${total.toLocaleString('es-CO')}*` : undefined;
      const paymentPrompt = this.conversationFlow.buildPaymentMethodPrompt(mutableContext, totalHint);
      const bbcResponse = await this.persistAndReply({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        customerPhone: input.customerPhone,
        messageId: input.messageId,
        history,
        userText: text,
        reply: paymentPrompt.replyText,
        salesContext: { ...mutableContext, ...paymentPrompt.salesContext },
        outbound: paymentPrompt.outbound,
        now,
        ragHits: 0,
      });
      return { replied: true, reply: paymentPrompt.replyText, bbcResponse };
    }

    const bbcResponse = await this.persistAndReply({
      tenantId: input.tenantId,
      deviceId: input.deviceId,
      customerPhone: input.customerPhone,
      messageId: input.messageId,
      history,
      userText: text,
      reply,
      salesContext: mutableContext,
      now,
      ragHits: 0,
    });

    return { replied: true, reply, bbcResponse };
  }

  async handleIncomingImage(input: SalesAgentImageInput): Promise<SalesAgentMessageResult> {
    if (!hasOpenAI) return { replied: false, reason: 'OPENAI_NOT_CONFIGURED' };
    if (!hasBuilderBot) return { replied: false, reason: 'BUILDERBOT_NOT_CONFIGURED' };

    const session = await this.chatRepo.find(input.tenantId, input.customerPhone);
    const salesContext = session?.salesContext ?? { phase: 'browsing' };
    const history = session?.messages ?? [];

    if (salesContext.phase !== 'awaiting_payment') {
      const reply =
        'Recibí tu imagen. Si deseas comprar, primero dime qué productos necesitas y te indicaré cómo realizar el pago.';
      await this.sendAndSave(input, history, '[Imagen enviada]', reply, salesContext);
      return { replied: true, reply };
    }

    const massiEnabled = await this.tools.massiBotEnabled(input.tenantId);

    if (massiEnabled && salesContext.massiWooOrderId) {
      if (!input.imageUrl) {
        const reply = 'Recibí tu mensaje, pero no pude obtener la imagen del comprobante. Intenta enviarla de nuevo.';
        await this.sendAndSave(input, history, '[Comprobante sin URL]', reply, salesContext);
        return { replied: true, reply };
      }

      const proof = await this.tools.submitMassiPaymentProof(
        input.tenantId,
        input.customerPhone,
        salesContext.massiWooOrderId,
        input.imageUrl
      );

      if (!proof.ok) {
        await this.sendAndSave(input, history, '[Comprobante de pago]', proof.message, salesContext);
        return { replied: true, reply: proof.message };
      }

      const invoice = salesContext.massiWooOrderNumber ?? String(salesContext.massiWooOrderId);
      const ticket = proof.ticketCode ?? salesContext.massiTicketCode;
      const reply = [
        '¡Gracias! Recibimos tu comprobante de pago.',
        `Pedido *#${invoice}*${ticket ? ` | Ticket *${ticket}*` : ''}.`,
        'Un asesor validará el pago. Te avisaremos por este chat cuando esté confirmado para que puedas recoger en la joyería.',
      ].join('\n');

      const updatedContext: SalesContext = { phase: 'order_created', lastOrderId: String(salesContext.massiWooOrderId) };
      await this.sendAndSave(input, history, '[Comprobante de pago recibido]', reply, updatedContext);

      await this.audit.log({
        tenantId: input.tenantId,
        userId: AGENT_ACTOR,
        action: 'MASSI_PAYMENT_PROOF_SUBMITTED',
        resource: 'woocommerce_order',
        resourceId: String(salesContext.massiWooOrderId),
        metadata: { customerPhone: input.customerPhone, ticketCode: ticket },
      });

      return { replied: true, reply };
    }

    if (!salesContext.cartItems?.length) {
      const reply =
        'Recibí tu imagen. Si deseas comprar, primero dime qué productos necesitas y te indicaré cómo realizar el pago.';
      await this.sendAndSave(input, history, '[Imagen enviada]', reply, salesContext);
      return { replied: true, reply };
    }

    const customerName = salesContext.customerName ?? input.customerPhone;
    const items = salesContext.cartItems as OrderItem[];

    const stockCheck = await this.tools.validateCartStock(input.tenantId, items);
    if (!stockCheck.ok) {
      const reply = `No pudimos crear el pedido: ${stockCheck.message}`;
      await this.sendAndSave(input, history, '[Comprobante de pago]', reply, { phase: 'browsing' });
      return { replied: true, reply };
    }

    const order = await this.createOrder.execute({
      tenantId: input.tenantId,
      customerPhone: input.customerPhone,
      customerName,
      items,
      notes: 'Pedido creado desde WhatsApp tras comprobante de pago',
      syncWooCommerce: true,
    });

    const invoice = order.woocommerceOrderNumber ?? order.id;
    const reply = [
      '¡Gracias! Recibimos tu comprobante de pago.',
      `Tu pedido fue registrado con número de factura *#${invoice}*.`,
      'Un asesor validará el pago manualmente. Cuando sea aprobado, te avisaremos por este chat para que puedas reclamar tu producto.',
    ].join('\n');

    const updatedContext: SalesContext = {
      phase: 'order_created',
      lastOrderId: order.id,
    };

    await this.sendAndSave(input, history, '[Comprobante de pago recibido]', reply, updatedContext);

    await this.audit.log({
      tenantId: input.tenantId,
      userId: AGENT_ACTOR,
      action: 'ORDER_CREATED_FROM_WHATSAPP',
      resource: 'order',
      resourceId: order.id,
      metadata: { customerPhone: input.customerPhone, invoice },
    });

    return { replied: true, reply };
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    input: SalesAgentMessageInput,
    salesContext: SalesContext
  ): Promise<string> {
    switch (name) {
      case 'buscar_en_documentos':
        return this.tools.searchDocuments(input.tenantId, String(args.consulta ?? ''));
      case 'buscar_productos_tienda':
        return this.tools.searchStoreProducts(input.tenantId, String(args.consulta ?? ''));
      case 'listar_variaciones':
        return this.tools.listVariations(input.tenantId, Number(args.product_id ?? args.productId ?? 0));
      case 'verificar_stock': {
        const result = await this.tools.checkStock(input.tenantId, {
          sku: args.sku ? String(args.sku) : undefined,
          productId: args.product_id ? Number(args.product_id) : args.productId ? Number(args.productId) : undefined,
          variationId: args.variation_id
            ? Number(args.variation_id)
            : args.variationId
              ? Number(args.variationId)
              : undefined,
          variantHint: args.variante ? String(args.variante) : args.variant ? String(args.variant) : undefined,
          productName: args.nombre_producto ? String(args.nombre_producto) : undefined,
          quantity: Number(args.cantidad ?? 1),
        });
        return result.message;
      }
      case 'agregar_producto_por_sku': {
        const sku = String(args.sku ?? '').trim();
        const quantity = Number(args.cantidad ?? 1);
        if (!sku) return 'Indica el SKU exacto del producto.';

        const built = await this.tools.buildOrderItemBySku(input.tenantId, sku, quantity);
        if (!built.ok || !built.item) return built.message;

        return this.addItemsToCart(input, salesContext, [built.item], args.nombre_cliente);
      }
      case 'agregar_al_carrito': {
        const newItems = this.parseOrderItems(args.productos);
        if (!newItems.length) return 'Debes indicar al menos un producto válido con SKU.';

        const stockCheck = await this.tools.validateCartStock(input.tenantId, newItems);
        if (!stockCheck.ok) return stockCheck.message;

        return this.addItemsToCart(input, salesContext, newItems, args.nombre_cliente);
      }
      case 'finalizar_compra':
      case 'preparar_pago': {
        if (args.nombre_cliente) {
          salesContext.customerName = String(args.nombre_cliente).trim();
        }
        return (await this.finalizeCart(input, salesContext)).message;
      }
      case 'consultar_pedidos': {
        return this.tools.listMassiOrders(input.tenantId, input.customerPhone);
      }
      default:
        return `Herramienta desconocida: ${name}`;
    }
  }

  private addItemsToCart(
    input: SalesAgentMessageInput,
    salesContext: SalesContext,
    newItems: OrderItem[],
    customerNameArg?: unknown
  ): string {
    const customerName = String(
      customerNameArg ?? salesContext.customerName ?? input.customerPhone
    ).trim();
    const merged = this.mergeCartItems(salesContext.cartItems, newItems);

    Object.assign(salesContext, {
      phase: 'browsing' as const,
      flowStep: 'buying' as const,
      cartItems: merged,
      customerName,
    });

    const summary = this.conversationFlow.formatCartSummary(merged);
    return [
      'Producto(s) agregado(s) al carrito:',
      summary,
      '',
      'Indica al cliente el resumen y pregúntale: *¿Deseas agregar algo más o eso sería todo?*',
      'NO menciones transferencia, Bre-B ni método de pago todavía.',
    ].join('\n');
  }

  private mergeCartItems(existing: PendingCartItem[] | undefined, newItems: OrderItem[]): PendingCartItem[] {
    const cart: PendingCartItem[] = [...(existing ?? [])];
    for (const item of newItems) {
      const idx = cart.findIndex((row) => row.sku === item.sku);
      if (idx >= 0) {
        cart[idx] = { ...cart[idx], quantity: cart[idx].quantity + item.quantity };
      } else {
        cart.push({ ...item });
      }
    }
    return cart;
  }

  private async finalizeCart(
    input: SalesAgentMessageInput,
    salesContext: SalesContext
  ): Promise<{ message: string; enteredPaymentSelect: boolean }> {
    const items = salesContext.cartItems ?? [];
    if (!items.length) {
      return { message: 'El carrito está vacío. Primero agrega productos con agregar_al_carrito.', enteredPaymentSelect: false };
    }

    if (salesContext.flowStep === 'payment_select') {
      return {
        message: 'El carrito ya está listo. El cliente debe elegir transferencia o efectivo con los botones de WhatsApp.',
        enteredPaymentSelect: false,
      };
    }

    const stockCheck = await this.tools.validateCartStock(input.tenantId, items);
    if (!stockCheck.ok) {
      return { message: stockCheck.message, enteredPaymentSelect: false };
    }

    const customerName = String(salesContext.customerName ?? input.customerPhone).trim();
    const massiEnabled = await this.tools.massiBotEnabled(input.tenantId);
    const total = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const summary = this.conversationFlow.formatCartSummary(items);

    if (massiEnabled) {
      Object.assign(salesContext, {
        phase: 'browsing' as const,
        flowStep: 'payment_select' as const,
        cartItems: items,
        customerName,
      });

      return {
        message: [
          'Carrito confirmado. Se mostrarán los botones de pago al cliente.',
          summary,
          `Total: $${total.toLocaleString('es-CO')}.`,
        ].join('\n'),
        enteredPaymentSelect: true,
      };
    }

    Object.assign(salesContext, this.tools.buildAwaitingPaymentContext(salesContext, items, customerName));
    const tenantConfig = await this.configRepo.findByTenantId(input.tenantId);
    const bankInfo = tenantConfig?.business?.bankAccountInfo ?? 'Consulta al negocio los datos de pago.';

    return {
      message: [
        'Stock validado correctamente.',
        summary,
        `Datos para transferencia:\n${bankInfo}`,
        'Indica al cliente que envíe una captura o foto del comprobante de pago por este chat.',
      ].join('\n'),
      enteredPaymentSelect: false,
    };
  }

  private parseOrderItems(raw: unknown): OrderItem[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        const row = item as Record<string, unknown>;
        return {
          productId: Number(row.productId),
          variationId: row.variationId ? Number(row.variationId) : undefined,
          sku: String(row.sku ?? ''),
          name: String(row.name ?? ''),
          quantity: Number(row.quantity ?? 1),
          unitPrice: Number(row.unitPrice ?? 0),
        };
      })
      .filter((item) => item.productId > 0 && item.sku && item.name && item.quantity > 0);
  }

  private buildSystemPrompt(input: {
    businessName: string;
    businessProfile?: {
      description?: string;
      address?: string;
      businessHours?: string;
      bankAccountInfo?: string;
    };
    salesPhase: SalesContext['phase'];
    flowStep?: SalesContext['flowStep'];
    cartItemCount: number;
  }): string {
    const profileLines = [
      input.businessProfile?.description ? `Descripción: ${input.businessProfile.description}` : null,
      input.businessProfile?.address ? `Dirección: ${input.businessProfile.address}` : null,
      input.businessProfile?.businessHours ? `Horario: ${input.businessProfile.businessHours}` : null,
      input.businessProfile?.bankAccountInfo ? `Datos de pago: ${input.businessProfile.bankAccountInfo}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const phaseHint =
      input.salesPhase === 'awaiting_payment'
        ? 'FASE ACTUAL: esperando comprobante de pago. Recuérdale al cliente enviar la captura.'
        : input.salesPhase === 'order_created'
          ? 'FASE ACTUAL: pedido ya registrado. Ayuda con seguimiento si pregunta.'
          : input.flowStep === 'buying'
            ? `FASE ACTUAL: armando pedido (${input.cartItemCount} producto(s) en carrito). Si el cliente quiere otro producto, búscalo y usa agregar_al_carrito. Si confirma que no desea agregar más (ej. "eso es todo", "continuar con la compra"), usa finalizar_compra. NO hables de transferencia ni pago hasta finalizar_compra.`
            : 'FASE ACTUAL: exploración y venta.';

    return [
      `Eres el asistente de ventas por WhatsApp de "${input.businessName}".`,
      'Responde en español, amable y conciso (máximo 3 párrafos).',
      'FLUJO DE VENTA:',
      '1) Si el cliente escribe hola/menú, el sistema ya envió el saludo de bienvenida; no repitas otro saludo genérico.',
      '2) IDENTIFICADOR PRINCIPAL: SKU. Cada variación tiene SKU único.',
      '3) Si el cliente elige un producto ya listado: usa agregar_producto_por_sku(sku) en UN solo paso. No encadenes buscar + verificar + agregar.',
      '4) Cuando agregues al carrito, pregunta *¿Deseas agregar algo más o eso sería todo?*',
      '5) NO menciones transferencia ni pago hasta que el cliente confirme que no quiere agregar más → entonces finalizar_compra.',
      '6) Usa la menor cantidad de herramientas posible por mensaje.',
      'No inventes productos ni precios. Usa las herramientas.',
      phaseHint,
      profileLines ? `\nInformación del negocio:\n${profileLines}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async persistAndReply(params: {
    tenantId: string;
    deviceId: string;
    customerPhone: string;
    messageId?: string;
    history: ChatMessage[];
    userText: string;
    reply: string;
    salesContext: SalesContext;
    outbound?: OutboundWhatsAppMessage;
    now: string;
    ragHits: number;
  }): Promise<BbcWebhookAgentResponse> {
    const updatedMessages: ChatMessage[] = [
      ...params.history,
      { role: 'user', content: params.userText, at: params.now },
      { role: 'assistant', content: params.reply, at: params.now },
    ];

    await this.chatRepo.save({
      tenantId: params.tenantId,
      customerPhone: params.customerPhone,
      messages: updatedMessages,
      salesContext: params.salesContext,
      updatedAt: params.now,
    });

    const outbound = params.outbound ?? { kind: 'text' as const, body: params.reply };
    const useCloudRelay = resolveBuilderBotApiMode() === 'cloud-v2';

    if (useCloudRelay) {
      const route = resolveBbcUiRoute(outbound);
      const phone = normalizeBuilderBotPhone(params.customerPhone);

      if (route === 'payment') {
        await this.audit.log({
          tenantId: params.tenantId,
          userId: AGENT_ACTOR,
          action: 'BUILDERBOT_MESSAGE_SENT',
          resource: 'whatsapp_message',
          resourceId: params.messageId,
          metadata: {
            customerPhone: params.customerPhone,
            replyPreview: params.reply.slice(0, 120),
            ragHits: params.ragHits,
            salesPhase: params.salesContext.phase,
            bbcRoute: 'payment',
          },
        });

        logger.info(
          {
            tenantId: params.tenantId,
            customerPhone: params.customerPhone,
            salesPhase: params.salesContext.phase,
            bbcRoute: 'payment',
          },
          'Agente enrutó selección de pago al flow UI de BuilderBot'
        );

        return { route: 'payment' };
      }

      await this.builderBot.sendTextMessage({
        deviceId: params.deviceId,
        phone,
        message: outbound.body,
      });

      await this.audit.log({
        tenantId: params.tenantId,
        userId: AGENT_ACTOR,
        action: 'BUILDERBOT_MESSAGE_SENT',
        resource: 'whatsapp_message',
        resourceId: params.messageId,
        metadata: {
          customerPhone: params.customerPhone,
          replyPreview: params.reply.slice(0, 120),
          ragHits: params.ragHits,
          salesPhase: params.salesContext.phase,
          bbcRoute: 'none',
        },
      });

      logger.info(
        {
          tenantId: params.tenantId,
          customerPhone: params.customerPhone,
          salesPhase: params.salesContext.phase,
        },
        'Agente de ventas respondió por WhatsApp (API v2)'
      );

      return { route: 'none' };
    }

    const phone = normalizeBuilderBotPhone(params.customerPhone);

    if (outbound.kind === 'buttons') {
      await this.builderBot.sendButtonsMessage({
        deviceId: params.deviceId,
        phone,
        body: outbound.body,
        footer: outbound.footer,
        buttons: outbound.buttons,
      });
    } else {
      await this.builderBot.sendTextMessage({
        deviceId: params.deviceId,
        phone,
        message: outbound.body,
      });
    }

    await this.audit.log({
      tenantId: params.tenantId,
      userId: AGENT_ACTOR,
      action: 'BUILDERBOT_MESSAGE_SENT',
      resource: 'whatsapp_message',
      resourceId: params.messageId,
      metadata: {
        customerPhone: params.customerPhone,
        replyPreview: params.reply.slice(0, 120),
        ragHits: params.ragHits,
        salesPhase: params.salesContext.phase,
      },
    });

    logger.info(
      {
        tenantId: params.tenantId,
        customerPhone: params.customerPhone,
        salesPhase: params.salesContext.phase,
      },
      'Agente de ventas respondió por WhatsApp'
    );

    return emptyBbcWebhookResponse();
  }

  private async sendAndSave(
    input: SalesAgentImageInput,
    history: ChatMessage[],
    userText: string,
    reply: string,
    salesContext: SalesContext
  ): Promise<void> {
    const now = new Date().toISOString();
    const updatedMessages: ChatMessage[] = [
      ...history,
      { role: 'user', content: userText, at: now },
      { role: 'assistant', content: reply, at: now },
    ];

    await this.chatRepo.save({
      tenantId: input.tenantId,
      customerPhone: input.customerPhone,
      messages: updatedMessages,
      salesContext,
      updatedAt: now,
    });

    await this.builderBot.sendTextMessage({
      deviceId: input.deviceId,
      phone: normalizeBuilderBotPhone(input.customerPhone),
      message: reply,
    });
  }
}
