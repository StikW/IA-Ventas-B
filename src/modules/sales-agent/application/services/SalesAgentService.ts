import OpenAI from 'openai';
import { inject, injectable } from 'tsyringe';
import { hasBuilderBot, hasOpenAI } from '../../../../shared/infrastructure/config/env';
import { AuditService } from '../../../../shared/infrastructure/audit/AuditService';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { IBuilderBotCloudService } from '../../../builderbot/domain/IBuilderBotCloudService';
import { normalizeBuilderBotPhone } from '../../../builderbot/infrastructure/builderBotPhone';
import { CreateOrderUseCase } from '../../../commerce/application/use-cases/OrderUseCases';
import { OrderItem } from '../../../commerce/domain/entities/Order.types';
import { IBusinessRepository } from '../../../tenant/domain/repositories/IBusinessRepository';
import { IConfigRepository } from '../../../tenant/domain/repositories/IConfigRepository';
import { ChatMessage, IChatSessionRepository, SalesContext } from '../../domain/IChatSessionRepository';
import { OpenAIChatAdapter } from '../../infrastructure/ai/OpenAIChatAdapter';
import { SalesAgentToolsHandler } from './SalesAgentToolsHandler';
import { ConversationFlowService, OutboundWhatsAppMessage } from './ConversationFlowService';

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
      description: 'Busca productos en WooCommerce por nombre o descripción.',
      parameters: {
        type: 'object',
        properties: { consulta: { type: 'string' } },
        required: ['consulta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_variaciones',
      description:
        'Lista variaciones (promoción, talla, etc.) de un producto variable MASSI. Usar productId de buscar_productos_tienda.',
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
        'Verifica disponibilidad. MASSI usa product_id (y variation_id si aplica); SKU suele estar vacío.',
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'number', description: 'ID WooCommerce del producto' },
          variation_id: { type: 'number', description: 'ID de variación si el cliente ya eligió' },
          sku: { type: 'string', description: 'Opcional; muchos productos MASSI no tienen SKU' },
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
      name: 'preparar_pago',
      description:
        'Valida stock y crea el pedido en MASSI listo para recibir comprobante. Usar cuando el cliente confirma compra por transferencia (Bre-B).',
      parameters: {
        type: 'object',
        properties: {
          nombre_cliente: { type: 'string' },
          metodo_pago: { type: 'string', description: 'mdp_788 transferencia Bre-B, mdp_789 efectivo en tienda' },
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
              required: ['productId', 'name', 'quantity', 'unitPrice'],
            },
          },
        },
        required: ['nombre_cliente', 'productos'],
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
    const salesContext: SalesContext = session?.salesContext ?? { phase: 'browsing' };

    const flowResult = await this.conversationFlow.tryHandle({
      tenantId: input.tenantId,
      customerPhone: input.customerPhone,
      text,
      businessName,
      salesContext,
      historyLength: history.length,
    });

    if (flowResult) {
      const now = new Date().toISOString();
      await this.persistAndReply({
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
      return { replied: true, reply: flowResult.replyText };
    }

    const systemPrompt = this.buildSystemPrompt({
      businessName,
      businessProfile: tenantConfig?.business,
      salesPhase: salesContext.phase,
    });

    let mutableContext = { ...salesContext };

    const reply = await this.chat.completeWithTools({
      systemPrompt,
      history,
      userMessage: text,
      tools: SALES_TOOLS,
      onToolCall: async (name, args) => this.executeTool(name, args, input, mutableContext),
    });

    const now = new Date().toISOString();

    if (mutableContext.flowStep === 'payment_select') {
      const total = mutableContext.cartItems?.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
      const totalHint = total ? `Total estimado: *$${total.toLocaleString('es-CO')}*` : undefined;
      const paymentPrompt = this.conversationFlow.buildPaymentMethodPrompt(mutableContext, totalHint);
      await this.persistAndReply({
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
      return { replied: true, reply: paymentPrompt.replyText };
    }

    await this.persistAndReply({
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

    return { replied: true, reply };
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
          quantity: Number(args.cantidad ?? 1),
        });
        return result.message;
      }
      case 'preparar_pago': {
        const items = this.parseOrderItems(args.productos);
        if (!items.length) return 'Debes indicar al menos un producto válido.';

        const stockCheck = await this.tools.validateCartStock(input.tenantId, items);
        if (!stockCheck.ok) return stockCheck.message;

        const customerName = String(args.nombre_cliente ?? input.customerPhone).trim();
        const massiEnabled = await this.tools.massiBotEnabled(input.tenantId);

        if (massiEnabled) {
          Object.assign(salesContext, {
            phase: 'browsing' as const,
            flowStep: 'payment_select' as const,
            cartItems: items,
            customerName,
          });

          const total = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
          return [
            'Stock validado correctamente.',
            `Total estimado: $${total.toLocaleString('es-CO')}.`,
            'El cliente elegirá transferencia o efectivo con los botones de WhatsApp.',
          ].join('\n');
        }

        Object.assign(salesContext, this.tools.buildAwaitingPaymentContext(salesContext, items, customerName));

        const tenantConfig = await this.configRepo.findByTenantId(input.tenantId);
        const bankInfo = tenantConfig?.business?.bankAccountInfo ?? 'Consulta al negocio los datos de pago.';
        return [
          'Stock validado correctamente.',
          `Datos para transferencia:\n${bankInfo}`,
          'Indica al cliente que envíe una captura o foto del comprobante de pago por este chat.',
        ].join('\n');
      }
      case 'consultar_pedidos': {
        return this.tools.listMassiOrders(input.tenantId, input.customerPhone);
      }
      default:
        return `Herramienta desconocida: ${name}`;
    }
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
      .filter((item) => item.productId > 0 && item.name && item.quantity > 0);
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
          : 'FASE ACTUAL: exploración y venta.';

    return [
      `Eres el asistente de ventas por WhatsApp de "${input.businessName}".`,
      'Responde en español, amable y conciso (máximo 3 párrafos).',
      'FLUJO DE VENTA:',
      '1) Saluda y ayuda al cliente. Si escribe *menú* o *hola*, puede usar los botones del menú principal.',
      '2) Si busca productos, usa buscar_en_documentos y buscar_productos_tienda. Muestra productId, precio y si es variable usa listar_variaciones.',
      '3) Productos MASSI suelen ser variables sin SKU: usa product_id y variation_id, no inventes SKU.',
      '4) Antes de preparar_pago, verifica stock con verificar_stock (product_id + variation_id si aplica).',
      '5) Cuando confirme compra (producto, variante, cantidad, nombre), usa preparar_pago.',
      '6) Tras elegir método de pago, pide comprobante (captura/foto) si pagó por transferencia.',
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
  }): Promise<void> {
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

    const phone = normalizeBuilderBotPhone(params.customerPhone);
    const outbound = params.outbound ?? { kind: 'text' as const, body: params.reply };

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
  }

  private async sendAndSave(
    input: SalesAgentImageInput,
    history: ChatMessage[],
    userText: string,
    reply: string,
    salesContext: SalesContext
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.persistAndReply({
      tenantId: input.tenantId,
      deviceId: input.deviceId,
      customerPhone: input.customerPhone,
      messageId: input.messageId,
      history,
      userText,
      reply,
      salesContext,
      now,
      ragHits: 0,
    });
  }
}
