import OpenAI from 'openai';
import { inject, injectable } from 'tsyringe';
import { hasBuilderBot, hasOpenAI } from '../../../../shared/infrastructure/config/env';
import { AuditService } from '../../../../shared/infrastructure/audit/AuditService';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { IBuilderBotCloudService } from '../../../builderbot/domain/IBuilderBotCloudService';
import {
  BbcUiRoute,
  BbcWebhookAgentResponse,
  emptyBbcWebhookResponse,
} from '../../../builderbot/domain/BbcWebhookAgentResponse';
import { resolveBuilderBotApiMode } from '../../../builderbot/infrastructure/builderBotApiMode';
import { normalizeBuilderBotPhone } from '../../../builderbot/infrastructure/builderBotPhone';
import { CreateOrderUseCase } from '../../../commerce/application/use-cases/OrderUseCases';
import { OrderItem } from '../../../commerce/domain/entities/Order.types';
import { IBusinessRepository } from '../../../tenant/domain/repositories/IBusinessRepository';
import { IConfigRepository } from '../../../tenant/domain/repositories/IConfigRepository';
import { ChatMessage, FocusedProduct, IChatSessionRepository, OfferedOption, PendingCartItem, PendingPackQuote, SalesContext } from '../../domain/IChatSessionRepository';
import { OpenAIChatAdapter } from '../../infrastructure/ai/OpenAIChatAdapter';
import { SalesAgentToolsHandler, ProductResolution, ProductResolutionBatch } from './SalesAgentToolsHandler';
import {
  ConversationFlowResult,
  ConversationFlowService,
  OutboundWhatsAppMessage,
  OutboundWhatsAppPayload,
} from './ConversationFlowService';
import {
  joinTextBlocks,
  renderButtonOptions,
  renderLinkBlock,
} from '../../../builderbot/domain/interactiveFallback.utils';
import { CATALOG_CTA_LABEL } from '../../domain/catalogUrl.utils';
import { CartService } from './CartService';
import { resolveBbcUiRoute } from '../../domain/bbcUiRoute';
import { buildGratitudeReply, isPureGratitude, stripGratitudeForProcessing } from '../../domain/gratitude.utils';
import { isCartFinalizeIntent, isMenuGreeting, isProductSelectionIntent, WA_BTN, WA_BTN_LABEL } from '../../domain/whatsappFlow.constants';
import { isCartClearIntent, isCartCorrectionIntent, isCartIncrementIntent, isCartKeepOnlyIntent, isCartRemoveIntent, isCartReviewIntent, isCartSetQuantityIntent } from '../../domain/cartModification.utils';
import { extractAllVariantHints, extractExplicitSkus, extractProductFamilyTerm, hasConcreteProductSpec, isCatalogBrowseIntent, isDirectVariantAddIntent, isProductFamilyBrowseIntent, isProductOptionsBrowseIntent, isThemeBrowseCandidate, mentionsDifferentPackProduct, normalizeUserTypos, shouldAbandonPendingPackFlow } from '../../domain/productSelection.utils';
import {
  composePacks,
  extractDesiredUnits,
  formatPackQuantityPrompt,
  formatPackQuoteMessage,
  isPackPriceQuestion,
  isPackQuoteAddIntent,
  isPackQuoteConfirmIntent,
  isPackQuoteRejectIntent,
  packQuoteToOrderItems,
  stripPriceQuestionWords,
  type PackQuote,
} from '../../domain/packPricing.utils';
import {
  formatProductPageLink,
  formatProductPageMissing,
  formatProductPageNeedChoice,
  isProductPageInfoIntent,
  stripProductPageWords,
} from '../../domain/productPage.utils';
import {
  extractListedProductNumber,
  findListedProductNumberAmbiguity,
  findOfferedOption,
} from '../../domain/optionReference.utils';
import { buildListedNumberChoiceMessage } from '../../domain/productDisplay.utils';
import { extractBalinSizeQuery } from '../../domain/balinBrowse.utils';
import { EMOJI, warmAddedOpener } from '../../domain/tone.utils';
import { WhatsAppCatalogOrderProduct } from '../../../builderbot/domain/whatsappCatalogOrder.utils';

const AGENT_ACTOR = 'system:sales-agent';

export interface WhatsAppCatalogOrderInput {
  tenantId: string;
  deviceId: string;
  customerPhone: string;
  customerName?: string;
  products: WhatsAppCatalogOrderProduct[];
  messageId?: string;
}

/**
 * Distingue «no hay stock» (hay que contarlo) de «no identifiqué el producto» (pedir ID).
 * Solo frases que produce el sistema: los mensajes citan el texto del cliente y palabras
 * como "unidades" darían falsos positivos.
 */
const STOCK_ISSUE_PATTERN = /sin stock|no hay stock|stock insuficiente|solo (?:hay|quedan)|agotad/i;

/**
 * Sin herramientas de búsqueda por nombre ni de listado de variaciones: el agente nunca
 * sugiere productos. Si no llega un SKU, se pide el ID y se remite al catálogo de la tienda.
 */
const SALES_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'buscar_en_documentos',
      description:
        'Busca en el catálogo vectorizado (PDF/TXT del panel) para interpretar qué producto pide el cliente y obtener su SKU/ID. NO usar para stock ni precios finales: valida después con agregar_producto_por_sku. Nunca listes al cliente los productos que devuelva.',
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
      name: 'verificar_stock',
      description:
        'Verifica disponibilidad por SKU (obligatorio y preferido). Cada variación en WooCommerce debe tener SKU único.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'SKU exacto de la variación o producto simple' },
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
          sku: { type: 'string', description: 'SKU exacto del producto o variación en WooCommerce' },
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
        'Agrega uno o varios productos al carrito por su ID (SKU). Nombre, precio y stock los toma WooCommerce: no los envíes. PROHIBIDO agregar varias variaciones del mismo producto si el cliente no eligió cada una; en ese caso lista las opciones con su ID y espera. NO inicia el pago.',
      parameters: {
        type: 'object',
        properties: {
          nombre_cliente: { type: 'string' },
          productos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sku: { type: 'string', description: 'ID/SKU exacto de la variación en WooCommerce' },
                cantidad: { type: 'number', description: 'Cantidad (default 1)' },
              },
              required: ['sku'],
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
        'Usar SOLO cuando el cliente confirma que no desea agregar más productos (ej. "eso es todo"). Valida stock y envía enlace al formulario de compra WooCommerce (modo link) o botones de pago (modo whatsapp legacy).',
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

  /**
   * Pedido del catálogo nativo de WhatsApp (EVENTS.ORDER / flow IA Ventas — Orden).
   * Carga retailerId+qty en el carrito de sesión y responde con el mismo prompt post-agregar.
   */
  async handleWhatsAppCatalogOrder(input: WhatsAppCatalogOrderInput): Promise<SalesAgentMessageResult> {
    if (!hasBuilderBot) return { replied: false, reason: 'BUILDERBOT_NOT_CONFIGURED' };
    if (!input.products.length) return { replied: false, reason: 'EMPTY_ORDER' };

    const session = await this.chatRepo.find(input.tenantId, input.customerPhone);
    const history = session?.messages ?? [];
    const mutableContext: SalesContext = {
      ...(session?.salesContext ?? { phase: 'browsing' }),
    };

    const added: OrderItem[] = [];
    const failures: string[] = [];

    for (const product of input.products) {
      const built = await this.tools.buildOrderItemByRetailerId(
        input.tenantId,
        product.retailerId,
        product.quantity
      );
      if (built.ok && built.item) {
        added.push(built.item);
      } else {
        failures.push(built.message || `No pude agregar ${product.retailerId}.`);
      }
    }

    const userText = `[pedido catálogo WhatsApp] ${input.products
      .map((p) => `${p.retailerId} x${p.quantity}`)
      .join(', ')}`;

    if (!added.length) {
      const body = [
        'Recibí tu pedido del catálogo, pero no pude cargar los productos en el carrito.',
        ...failures.map((f) => `· ${f}`),
        '',
        'Envíame el *ID* del producto o vuelve a elegir desde el catálogo.',
      ].join('\n');
      const now = new Date().toISOString();
      const bbcResponse = await this.persistAndReply({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        customerPhone: input.customerPhone,
        messageId: input.messageId,
        history,
        userText,
        reply: body,
        salesContext: {
          ...mutableContext,
          phase: 'browsing',
          flowStep: 'discovery',
          customerName: input.customerName ?? mutableContext.customerName,
        },
        outbound: { kind: 'text', body },
        uiRoute: 'catalog',
        now,
        ragHits: 0,
      });
      return { replied: true, reply: body, bbcResponse };
    }

    this.addItemsToCart(input, mutableContext, added, input.customerName);

    const addedNames = added.map((item) => `· ${item.name} x${item.quantity}`).join('\n');
    const introParts = [
      '¡Listo! Cargué tu pedido del catálogo de WhatsApp en el carrito:',
      addedNames,
    ];
    if (failures.length) {
      introParts.push('', 'No pude agregar:', ...failures.map((f) => `· ${f}`));
    }
    introParts.push('', 'Así va tu carrito:');

    const cartPrompt = this.conversationFlow.buildCartActionPrompt(
      mutableContext,
      introParts.join('\n')
    );
    const now = new Date().toISOString();
    const bbcResponse = await this.persistAndReply({
      tenantId: input.tenantId,
      deviceId: input.deviceId,
      customerPhone: input.customerPhone,
      messageId: input.messageId,
      history,
      userText,
      reply: cartPrompt.replyText,
      salesContext: cartPrompt.salesContext,
      outbound: cartPrompt.outbound,
      uiRoute: cartPrompt.uiRoute,
      now,
      ragHits: 0,
    });

    return { replied: true, reply: cartPrompt.replyText, bbcResponse };
  }

  async handleIncomingMessage(input: SalesAgentMessageInput): Promise<SalesAgentMessageResult> {
    if (!hasOpenAI) return { replied: false, reason: 'OPENAI_NOT_CONFIGURED' };
    if (!hasBuilderBot) return { replied: false, reason: 'BUILDERBOT_NOT_CONFIGURED' };

    const originalText = normalizeUserTypos(input.text.trim());
    if (!originalText) return { replied: false, reason: 'EMPTY_MESSAGE' };

    const gratitudeStrip = stripGratitudeForProcessing(originalText);
    const text =
      gratitudeStrip.hadGratitude && gratitudeStrip.stripped ? gratitudeStrip.stripped : originalText;

    const business = await this.businessRepo.findById(input.tenantId);
    const businessName = business?.name ?? 'el negocio';
    const tenantConfig = await this.configRepo.findByTenantId(input.tenantId);
    const session = await this.chatRepo.find(input.tenantId, input.customerPhone);
    const history = session?.messages ?? [];
    let salesContext: SalesContext = session?.salesContext ?? { phase: 'browsing' };

    // Saludo/menú: volver al menú principal (conserva carrito).
    if (
      isMenuGreeting(text) &&
      (salesContext.flowStep === 'payment_select' ||
        salesContext.flowStep === 'buying' ||
        salesContext.flowStep === 'checkout_redirect' ||
        salesContext.flowStep === 'discovery')
    ) {
      salesContext = {
        phase: 'browsing',
        flowStep: 'discovery',
        cartItems: salesContext.cartItems,
        customerName: salesContext.customerName,
        lastOptions: salesContext.lastOptions,
        focusedProduct: salesContext.focusedProduct,
        lastAddedSkus: salesContext.lastAddedSkus,
        lastCheckoutUrl: salesContext.lastCheckoutUrl,
      };
    }

    const productPageEarly = await this.handleProductPageTurn(input, salesContext, text);
    if (productPageEarly) {
      const now = new Date().toISOString();
      const bbcResponse = await this.persistAndReply({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        customerPhone: input.customerPhone,
        messageId: input.messageId,
        history,
        userText: text,
        reply: productPageEarly.replyText,
        salesContext: productPageEarly.salesContext,
        outbound: productPageEarly.outbound,
        uiRoute: productPageEarly.uiRoute,
        now,
        ragHits: 0,
      });
      return { replied: true, reply: productPageEarly.replyText, bbcResponse };
    }

    let mutableContext: SalesContext = { ...salesContext };

    // Letra / ID / posición del último listado, antes que el menú o una cotización de
    // granel: "quiero dos unidades del a" no es "agregar algo más" ni confirma un paquete.
    if (
      mutableContext.lastOptions?.length &&
      mutableContext.phase !== 'awaiting_payment' &&
      mutableContext.flowStep !== 'payment_select'
    ) {
      const listedReply = await this.resolveLastOptionsTurn(input, mutableContext, text, history);
      if (listedReply) return listedReply;
    }

    if (isPureGratitude(originalText)) {
      const gratitude = buildGratitudeReply(mutableContext, mutableContext.lastCheckoutUrl);
      const now = new Date().toISOString();
      const bbcResponse = await this.persistAndReply({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        customerPhone: input.customerPhone,
        messageId: input.messageId,
        history,
        userText: originalText,
        reply: gratitude.body,
        salesContext: mutableContext,
        outbound: { kind: 'text', body: gratitude.body },
        uiRoute: gratitude.uiRoute,
        now,
        ragHits: 0,
      });
      return { replied: true, reply: gratitude.body, bbcResponse };
    }

    const flowResult = await this.conversationFlow.tryHandle({
      tenantId: input.tenantId,
      customerPhone: input.customerPhone,
      text,
      businessName,
      businessProfile: tenantConfig?.business,
      salesContext: mutableContext,
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
        userText: originalText,
        reply: flowResult.replyText,
        salesContext: flowResult.salesContext,
        outbound: flowResult.outbound,
        uiRoute: flowResult.uiRoute,
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

    const pendingPack = await this.handlePendingPackTurn(input, mutableContext, text);
    if (pendingPack) {
      const now = new Date().toISOString();
      const bbcResponse = await this.persistAndReply({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        customerPhone: input.customerPhone,
        messageId: input.messageId,
        history,
        userText: text,
        reply: pendingPack.replyText,
        salesContext: { ...mutableContext, ...pendingPack.salesContext },
        outbound: pendingPack.outbound,
        uiRoute: pendingPack.uiRoute,
        now,
        ragHits: 0,
      });
      return { replied: true, reply: pendingPack.replyText, bbcResponse };
    }

    if (isCartFinalizeIntent(text) && mutableContext.cartItems?.length) {
      const cartSnapshot = [...(mutableContext.cartItems ?? [])];
      const finalizeReply = await this.finalizeCart(input, mutableContext, tenantConfig?.business);
      const now = new Date().toISOString();

      if (finalizeReply.enteredCheckoutLink && finalizeReply.checkoutUrl) {
        const checkoutPrompt = this.conversationFlow.buildCheckoutLinkReply(
          mutableContext,
          finalizeReply.checkoutUrl,
          input.customerPhone,
          cartSnapshot
        );
        const bbcResponse = await this.persistAndReply({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: input.customerPhone,
          messageId: input.messageId,
          history,
          userText: text,
          reply: checkoutPrompt.replyText,
          salesContext: { ...mutableContext, ...checkoutPrompt.salesContext },
          outbound: checkoutPrompt.outbound,
          uiRoute: checkoutPrompt.uiRoute,
          now,
          ragHits: 0,
        });
        return { replied: true, reply: checkoutPrompt.replyText, bbcResponse };
      }

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

    if (isCartReviewIntent(text) && mutableContext.cartItems?.length) {
      const review = this.conversationFlow.buildCartActionPrompt(
        mutableContext,
        `${EMOJI.cart} Así va tu pedido ahora:`
      );
      const bbcResponse = await this.persistAndReply({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        customerPhone: input.customerPhone,
        messageId: input.messageId,
        history,
        userText: text,
        reply: review.replyText,
        salesContext: { ...mutableContext, ...review.salesContext },
        outbound: review.outbound,
        uiRoute: review.uiRoute,
        now: new Date().toISOString(),
        ragHits: 0,
      });
      return { replied: true, reply: review.replyText, bbcResponse };
    }

    const cartModIntent =
      isCartClearIntent(text) ||
      (mutableContext.cartItems?.length &&
        (isCartKeepOnlyIntent(text) ||
          isCartRemoveIntent(text) ||
          isCartCorrectionIntent(text) ||
          isCartSetQuantityIntent(text) ||
          isCartIncrementIntent(text)));

    if (cartModIntent) {
      const mod = await this.tools.applyCartModification(
        input.tenantId,
        text,
        mutableContext.cartItems ?? [],
        { lastAddedSkus: mutableContext.lastAddedSkus }
      );
      if (mod.handled) {
        mutableContext.cartItems = mod.items;
        mutableContext.flowStep = mod.items.length ? 'buying' : 'discovery';
        mutableContext.lastAddedSkus = mod.items.map((item) => item.sku);
        const now = new Date().toISOString();
        const cartPrompt = this.conversationFlow.buildCartActionPrompt(mutableContext, mod.message);
        const bbcResponse = await this.persistAndReply({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: input.customerPhone,
          messageId: input.messageId,
          history,
          userText: text,
          reply: cartPrompt.replyText,
          salesContext: { ...mutableContext, ...cartPrompt.salesContext },
          outbound: cartPrompt.outbound,
          now,
          ragHits: 0,
        });
        return { replied: true, reply: cartPrompt.replyText, bbcResponse };
      }
    }

    const wantsCheckoutLinkAgain =
      mutableContext.flowStep === 'checkout_redirect' &&
      (isCartFinalizeIntent(text) ||
        /formulario|link|enlace|checkout|completar\s+(la\s+)?compra|reenvi/i.test(text));

    if (wantsCheckoutLinkAgain && (mutableContext.lastCheckoutUrl || mutableContext.cartItems?.length)) {
      let checkoutUrl = mutableContext.lastCheckoutUrl;
      if (!checkoutUrl && mutableContext.cartItems?.length) {
        const link = await this.tools.buildCheckoutFormLink(
          input.tenantId,
          input.customerPhone,
          mutableContext.cartItems,
          tenantConfig?.business
        );
        checkoutUrl = link.ok ? link.url : undefined;
      }
      const now = new Date().toISOString();
      if (checkoutUrl) {
        const checkoutPrompt = this.conversationFlow.buildCheckoutLinkReply(
          mutableContext,
          checkoutUrl,
          input.customerPhone,
          mutableContext.cartItems
        );
        const bbcResponse = await this.persistAndReply({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: input.customerPhone,
          messageId: input.messageId,
          history,
          userText: text,
          reply: checkoutPrompt.replyText,
          salesContext: { ...mutableContext, ...checkoutPrompt.salesContext },
          outbound: checkoutPrompt.outbound,
          uiRoute: checkoutPrompt.uiRoute,
          now,
          ragHits: 0,
        });
        return { replied: true, reply: checkoutPrompt.replyText, bbcResponse };
      }
    }

    // «¿en cuánto me salen 7 balines #6?»: cotiza la combinación de paquetes sin tocar el carrito.
    if (
      isPackPriceQuestion(text) &&
      salesContext.phase !== 'awaiting_payment' &&
      mutableContext.flowStep !== 'checkout_redirect'
    ) {
      const productRef = stripPriceQuestionWords(text) || text;
      const selection = await this.tools.resolveSelectionsFromText(input.tenantId, productRef, 1, {
        cartItems: mutableContext.cartItems,
      });
      const packReply = this.applyPackSelection(input, mutableContext, selection, { addExtraItems: false });
      if (packReply) {
        const bbcResponse = await this.persistAndReply({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: input.customerPhone,
          messageId: input.messageId,
          history,
          userText: text,
          reply: packReply.replyText,
          salesContext: { ...mutableContext, ...packReply.salesContext },
          outbound: packReply.outbound,
          uiRoute: packReply.uiRoute,
          now: new Date().toISOString(),
          ragHits: 0,
        });
        return { replied: true, reply: packReply.replyText, bbcResponse };
      }
    }

    if (isProductFamilyBrowseIntent(text) && salesContext.phase !== 'awaiting_payment') {
      const hasDirectSelection = isDirectVariantAddIntent(text);

      if (hasDirectSelection) {
        const selection = await this.tools.resolveSelectionsFromText(input.tenantId, text, 1, {
          cartItems: mutableContext.cartItems,
        });
        const packReply = this.applyPackSelection(input, mutableContext, selection);
        if (packReply) {
          const now = new Date().toISOString();
          const bbcResponse = await this.persistAndReply({
            tenantId: input.tenantId,
            deviceId: input.deviceId,
            customerPhone: input.customerPhone,
            messageId: input.messageId,
            history,
            userText: text,
            reply: packReply.replyText,
            salesContext: { ...mutableContext, ...packReply.salesContext },
            outbound: packReply.outbound,
            uiRoute: packReply.uiRoute,
            now,
            ragHits: 0,
          });
          return { replied: true, reply: packReply.replyText, bbcResponse };
        }
        if (selection.items?.length) {
          this.addItemsToCart(input, mutableContext, selection.items);
          const cartPrompt = this.conversationFlow.buildCartActionPrompt(
            mutableContext,
            this.buildAddedIntroLine(selection.items, selection.message)
          );
          const now = new Date().toISOString();
          const bbcResponse = await this.persistAndReply({
            tenantId: input.tenantId,
            deviceId: input.deviceId,
            customerPhone: input.customerPhone,
            messageId: input.messageId,
            history,
            userText: text,
            reply: cartPrompt.replyText,
            salesContext: { ...mutableContext, ...cartPrompt.salesContext },
            outbound: cartPrompt.outbound,
            now,
            ragHits: 0,
          });
          return { replied: true, reply: cartPrompt.replyText, bbcResponse };
        }

        // Varias coincidencias para la descripción: mostrar el listado con IDs.
        if (selection.needsChoice) {
          const cartPrompt = this.conversationFlow.buildCartActionPrompt(
            mutableContext,
            selection.message
          );
          const bbcResponse = await this.persistAndReply({
            tenantId: input.tenantId,
            deviceId: input.deviceId,
            customerPhone: input.customerPhone,
            messageId: input.messageId,
            history,
            userText: text,
            reply: cartPrompt.replyText,
            salesContext: {
              ...mutableContext,
              ...cartPrompt.salesContext,
              lastOptions: selection.options ?? [],
            },
            outbound: cartPrompt.outbound,
            now: new Date().toISOString(),
            ragHits: 0,
            listedOptions: selection.options,
          });
          return { replied: true, reply: cartPrompt.replyText, bbcResponse };
        }
      }

      const browse = await this.tools.resolveProductFamilyBrowse(input.tenantId, text);
      const now = new Date().toISOString();

      if (browse.ok) {
        const cartPrompt = this.conversationFlow.buildCartActionPrompt(mutableContext, browse.message);
        const bbcResponse = await this.persistAndReply({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: input.customerPhone,
          messageId: input.messageId,
          history,
          userText: text,
          reply: cartPrompt.replyText,
          salesContext: {
            ...mutableContext,
            ...cartPrompt.salesContext,
            lastOptions: browse.options ?? [],
          },
          outbound: cartPrompt.outbound,
          now,
          ragHits: 0,
          listedOptions: browse.options,
        });
        return { replied: true, reply: cartPrompt.replyText, bbcResponse };
      }

      const familyTerm = extractProductFamilyTerm(text) ?? 'eso';
      const miss =
        browse.message?.trim() ||
        `No encontré ${familyTerm} en la tienda ahora mismo.`;
      const hint = mutableContext.lastOptions?.length
        ? ` Si te referías al listado anterior, dime la *letra* o el *ID*.`
        : ' Si buscas otro tipo de pieza, dime cuál o el *ID*.';
      const body = `${miss}${hint}`;
      const bbcResponse = await this.persistAndReply({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        customerPhone: input.customerPhone,
        messageId: input.messageId,
        history,
        userText: text,
        reply: body,
        salesContext: mutableContext,
        outbound: { kind: 'text', body },
        now,
        ragHits: 0,
      });
      return { replied: true, reply: body, bbcResponse };
    }

    if (isThemeBrowseCandidate(text) && salesContext.phase !== 'awaiting_payment') {
      const theme = await this.tools.resolveThemeBrowse(input.tenantId, text);
      if (theme.ok) {
        const cartPrompt = this.conversationFlow.buildCartActionPrompt(mutableContext, theme.message);
        const bbcResponse = await this.persistAndReply({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: input.customerPhone,
          messageId: input.messageId,
          history,
          userText: text,
          reply: cartPrompt.replyText,
          salesContext: {
            ...mutableContext,
            ...cartPrompt.salesContext,
            lastOptions: theme.options ?? [],
          },
          outbound: cartPrompt.outbound,
          now: new Date().toISOString(),
          ragHits: 0,
          listedOptions: theme.options,
        });
        return { replied: true, reply: cartPrompt.replyText, bbcResponse };
      }

      // Sin coincidencias: si el cliente solo preguntaba por el surtido, el enlace al
      // catálogo le sirve más que un "no encontré", así que se deja seguir el flujo.
      if (!isCatalogBrowseIntent(text)) {
        const miss =
          theme.message ||
          `No encontré piezas con esa forma en la tienda. Prueba con un nombre más concreto o el *ID*.`;
        const bbcResponse = await this.persistAndReply({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: input.customerPhone,
          messageId: input.messageId,
          history,
          userText: text,
          reply: miss,
          salesContext: mutableContext,
          outbound: { kind: 'text', body: miss },
          now: new Date().toISOString(),
          ragHits: 0,
        });
        return { replied: true, reply: miss, bbcResponse };
      }
    }

    if (isCatalogBrowseIntent(text) && salesContext.phase !== 'awaiting_payment') {
      const catalogPrompt = await this.conversationFlow.buildCatalogBrowseReply(input.tenantId, mutableContext);
      const now = new Date().toISOString();
      const bbcResponse = await this.persistAndReply({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        customerPhone: input.customerPhone,
        messageId: input.messageId,
        history,
        userText: text,
        reply: catalogPrompt.replyText,
        salesContext: { ...mutableContext, ...catalogPrompt.salesContext },
        outbound: catalogPrompt.outbound,
        uiRoute: catalogPrompt.uiRoute,
        now,
        ragHits: 0,
      });
      return { replied: true, reply: catalogPrompt.replyText, bbcResponse };
    }

    const shouldResolveProduct =
      salesContext.phase !== 'awaiting_payment' &&
      !isCartClearIntent(text) &&
      (isProductSelectionIntent(text) || hasConcreteProductSpec(text));

    if (shouldResolveProduct) {
      const selection = await this.tools.resolveSelectionsFromText(input.tenantId, text, 1, {
        cartItems: mutableContext.cartItems,
      });
      const packReply = this.applyPackSelection(input, mutableContext, selection);
      if (packReply) {
        const now = new Date().toISOString();
        const bbcResponse = await this.persistAndReply({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: input.customerPhone,
          messageId: input.messageId,
          history,
          userText: text,
          reply: packReply.replyText,
          salesContext: { ...mutableContext, ...packReply.salesContext },
          outbound: packReply.outbound,
          uiRoute: packReply.uiRoute,
          now,
          ragHits: 0,
        });
        return { replied: true, reply: packReply.replyText, bbcResponse };
      }
      if (selection.items?.length) {
        this.addItemsToCart(input, mutableContext, selection.items);
        const cartPrompt = this.conversationFlow.buildCartActionPrompt(
          mutableContext,
          this.buildAddedIntroLine(selection.items, selection.message)
        );
        const now = new Date().toISOString();
        const bbcResponse = await this.persistAndReply({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: input.customerPhone,
          messageId: input.messageId,
          history,
          userText: text,
          reply: cartPrompt.replyText,
          salesContext: { ...mutableContext, ...cartPrompt.salesContext },
          outbound: cartPrompt.outbound,
          now,
          ragHits: 0,
        });
        return { replied: true, reply: cartPrompt.replyText, bbcResponse };
      }

      // Varias coincidencias o variaciones por elegir: el mensaje ya trae el listado con IDs.
      // Falta de stock: el detalle importa. Producto no identificado: pedir ID + catálogo.
      if (selection.needsChoice || STOCK_ISSUE_PATTERN.test(selection.message)) {
        const now = new Date().toISOString();
        const cartPrompt = this.conversationFlow.buildCartActionPrompt(
          mutableContext,
          selection.message
        );
        const bbcResponse = await this.persistAndReply({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: input.customerPhone,
          messageId: input.messageId,
          history,
          userText: text,
          reply: cartPrompt.replyText,
          salesContext: {
            ...mutableContext,
            ...cartPrompt.salesContext,
            ...(selection.options ? { lastOptions: selection.options } : {}),
          },
          outbound: cartPrompt.outbound,
          now,
          ragHits: 0,
          listedOptions: selection.options,
        });
        return { replied: true, reply: cartPrompt.replyText, bbcResponse };
      }

      const helpPrompt = await this.conversationFlow.buildProductLookupHelpReply(
        input.tenantId,
        mutableContext
      );
      const now = new Date().toISOString();
      const bbcResponse = await this.persistAndReply({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        customerPhone: input.customerPhone,
        messageId: input.messageId,
        history,
        userText: text,
        reply: helpPrompt.replyText,
        salesContext: { ...mutableContext, ...helpPrompt.salesContext },
        outbound: helpPrompt.outbound,
        uiRoute: helpPrompt.uiRoute,
        now,
        ragHits: 0,
      });
      return { replied: true, reply: helpPrompt.replyText, bbcResponse };
    }

    // Variaciones agregadas por producto padre en este turno: el modelo intentaba volcar
    // todas las que devolvía el RAG cuando el cliente solo nombraba el producto.
    const addedThisTurn = new Map<number, number>();

    const reply = await this.chat.completeWithTools({
      systemPrompt,
      history,
      userMessage: text,
      tools: SALES_TOOLS,
      onToolCall: async (name, args) =>
        this.executeTool(name, args, input, mutableContext, addedThisTurn),
    });

    const now = new Date().toISOString();

    const enteredCheckoutLink =
      mutableContext.flowStep === 'checkout_redirect' && salesContext.flowStep !== 'checkout_redirect';

    if (enteredCheckoutLink && (mutableContext.lastCheckoutUrl || mutableContext.cartItems?.length)) {
      let checkoutUrl = mutableContext.lastCheckoutUrl;
      const cartSnapshot = [...(mutableContext.cartItems ?? [])];
      if (!checkoutUrl && cartSnapshot.length) {
        const link = await this.tools.buildCheckoutFormLink(
          input.tenantId,
          input.customerPhone,
          cartSnapshot,
          tenantConfig?.business
        );
        checkoutUrl = link.ok ? link.url : undefined;
      }
      if (checkoutUrl) {
        const checkoutPrompt = this.conversationFlow.buildCheckoutLinkReply(
          mutableContext,
          checkoutUrl,
          input.customerPhone,
          cartSnapshot
        );
        const bbcResponse = await this.persistAndReply({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          customerPhone: input.customerPhone,
          messageId: input.messageId,
          history,
          userText: text,
          reply: checkoutPrompt.replyText,
          salesContext: { ...mutableContext, ...checkoutPrompt.salesContext },
          outbound: checkoutPrompt.outbound,
          uiRoute: checkoutPrompt.uiRoute,
          now,
          ragHits: 0,
        });
        return { replied: true, reply: checkoutPrompt.replyText, bbcResponse };
      }
    }

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

  /** Respuesta amable cuando el procesamiento falla (ej. WooCommerce 502). */
  async sendProcessingErrorReply(input: SalesAgentMessageInput): Promise<SalesAgentMessageResult> {
    if (!hasBuilderBot) return { replied: false, reason: 'BUILDERBOT_NOT_CONFIGURED' };

    const session = await this.chatRepo.find(input.tenantId, input.customerPhone);
    const history = session?.messages ?? [];
    const salesContext = session?.salesContext ?? { phase: 'browsing' };
    const now = new Date().toISOString();

    const lines = [
      'Disculpa, no pude consultar la tienda en este momento. Intenta de nuevo en unos segundos.',
    ];
    if (salesContext.cartItems?.length) {
      lines.push('', 'Tu pedido actual:', this.conversationFlow.formatCartSummary(salesContext.cartItems));
    }

    const reply = lines.join('\n');
    const bbcResponse = await this.persistAndReply({
      tenantId: input.tenantId,
      deviceId: input.deviceId,
      customerPhone: input.customerPhone,
      messageId: input.messageId,
      history,
      userText: input.text.trim(),
      reply,
      salesContext,
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
    salesContext: SalesContext,
    addedThisTurn: Map<number, number>
  ): Promise<string> {
    switch (name) {
      case 'buscar_en_documentos':
        return this.tools.searchDocuments(input.tenantId, String(args.consulta ?? ''));
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

        const built = await this.tools.buildOrderItemBySku(input.tenantId, sku, quantity, {
          userText: input.text,
        });
        if (!built.ok || (!built.item && !built.packQuote && !built.needsQuantity)) return built.message;
        const packMsg = this.capturePackResolution(salesContext, built);
        if (packMsg) return packMsg;
        if (!built.item) return built.message;

        const blocked = this.guardVariationFlood(input.text, [built.item], addedThisTurn);
        if (blocked) return blocked;

        return this.addItemsToCart(input, salesContext, [built.item], args.nombre_cliente);
      }
      case 'agregar_al_carrito': {
        const requested = this.parseRequestedSkus(args.productos);
        if (!requested.length) return 'Debes indicar al menos un ID (SKU) de producto.';

        const newItems: OrderItem[] = [];
        const errors: string[] = [];
        for (const row of requested) {
          // Nombre y precio salen de WooCommerce: si los pusiera el modelo, podría
          // cobrarle al cliente un precio que no existe.
          const built = await this.tools.buildOrderItemBySku(input.tenantId, row.sku, row.quantity, {
            userText: input.text,
          });
          if (built.packQuote || built.needsQuantity) {
            const packMsg = this.capturePackResolution(salesContext, built);
            if (packMsg) return packMsg;
          }
          if (built.ok && built.item) newItems.push(built.item);
          else errors.push(built.message);
        }

        if (!newItems.length) {
          return errors[0] ?? 'Ninguno de esos ID corresponde a un producto de la tienda.';
        }

        const blocked = this.guardVariationFlood(input.text, newItems, addedThisTurn);
        if (blocked) return blocked;

        const added = this.addItemsToCart(input, salesContext, newItems, args.nombre_cliente);
        return errors.length ? `${added}\nNo pude agregar: ${errors.join(' ')}` : added;
      }
      case 'finalizar_compra':
      case 'preparar_pago': {
        if (args.nombre_cliente) {
          salesContext.customerName = String(args.nombre_cliente).trim();
        }
        const tenantConfig = await this.configRepo.findByTenantId(input.tenantId);
        return (await this.finalizeCart(input, salesContext, tenantConfig?.business)).message;
      }
      case 'consultar_pedidos': {
        return this.tools.listMassiOrders(input.tenantId, input.customerPhone);
      }
      default:
        return `Herramienta desconocida: ${name}`;
    }
  }

  private buildAddedIntroLine(items: OrderItem[], note?: string): string {
    const seed = items.map((item) => item.sku).join('|');
    const names = items.map((item) => `*${item.name}*`).join(', ');
    const intro =
      items.length === 1
        ? `${warmAddedOpener(seed)} Agregué ${names} a tu pedido ${EMOJI.cart}`
        : `${warmAddedOpener(seed)} Sumé ${items.length} productos a tu pedido ${EMOJI.cart} ${names}.`;

    return note?.trim() ? `${intro} ${note.trim()}` : intro;
  }

  /**
   * Letra, ID o posición sobre el último listado. Va antes que menú, granel y familia
   * para que "quiero dos unidades del a" no se pierda.
   */
  private async resolveLastOptionsTurn(
    input: SalesAgentMessageInput,
    mutableContext: SalesContext,
    text: string,
    history: ChatMessage[]
  ): Promise<SalesAgentMessageResult | null> {
    const listed = mutableContext.lastOptions;
    if (!listed?.length) return null;

    // En el menú de tipos de balín los nombres no llevan #. "#3" es un tamaño, no la tercera línea.
    if (
      extractBalinSizeQuery(text) &&
      listed.some((option) => (option.memberProductIds?.length ?? 0) > 1)
    ) {
      return null;
    }

    const ambiguousIndices = findListedProductNumberAmbiguity(text, listed);
    const listedNumber = extractListedProductNumber(text);
    if (ambiguousIndices && listedNumber) {
      const subset = ambiguousIndices.map((index) => listed[index]!);
      const choiceMessage = buildListedNumberChoiceMessage(listedNumber, subset);
      const cartPrompt = this.conversationFlow.buildCartActionPrompt(mutableContext, choiceMessage);
      const bbcResponse = await this.persistAndReply({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        customerPhone: input.customerPhone,
        messageId: input.messageId,
        history,
        userText: text,
        reply: choiceMessage,
        salesContext: { ...mutableContext, ...cartPrompt.salesContext, lastOptions: subset },
        outbound: cartPrompt.outbound,
        now: new Date().toISOString(),
        ragHits: 0,
        listedOptions: subset,
      });
      return { replied: true, reply: choiceMessage, bbcResponse };
    }

    const allowNameMatch =
      isProductOptionsBrowseIntent(text) ||
      (!isProductFamilyBrowseIntent(text) && !isThemeBrowseCandidate(text) && !isCatalogBrowseIntent(text));
    const optionReference = findOfferedOption(text, listed, { allowNameMatch });
    if (!optionReference) return null;

    mutableContext.pendingPackQuote = undefined;
    mutableContext.pendingPackProduct = undefined;
    const chosen = listed[optionReference.index]!;
    const optionReply = await this.resolveOfferedOption(
      input,
      mutableContext,
      chosen,
      optionReference.quantity
    );
    const bbcResponse = await this.persistAndReply({
      tenantId: input.tenantId,
      deviceId: input.deviceId,
      customerPhone: input.customerPhone,
      messageId: input.messageId,
      history,
      userText: text,
      reply: optionReply.replyText,
      salesContext: { ...mutableContext, ...optionReply.salesContext },
      outbound: optionReply.outbound,
      uiRoute: optionReply.uiRoute,
      now: new Date().toISOString(),
      ragHits: 0,
      listedOptions:
        optionReply.salesContext.lastOptions && optionReply.salesContext.lastOptions !== listed
          ? optionReply.salesContext.lastOptions
          : undefined,
    });
    return { replied: true, reply: optionReply.replyText, bbcResponse };
  }

  /**
   * El cliente eligió por posición. Un producto variable no tiene SKU propio en
   * WooCommerce: hay que mostrar sus variaciones, nunca agregarlas todas.
   */
  private async resolveOfferedOption(
    input: SalesAgentMessageInput,
    salesContext: SalesContext,
    option: OfferedOption,
    quantity: number
  ): Promise<ConversationFlowResult> {
    if (option.memberProductIds && option.memberProductIds.length > 1) {
      const listed = await this.tools.describeMemberProducts(input.tenantId, option);
      if (!listed.ok) {
        return {
          replyText: listed.message,
          outbound: { kind: 'text', body: listed.message },
          salesContext,
        };
      }

      const prompt = this.conversationFlow.buildCartActionPrompt(salesContext, listed.message);
      return {
        ...prompt,
        salesContext: { ...prompt.salesContext, lastOptions: listed.options ?? [] },
      };
    }

    if (!option.sku || option.variable) {
      const listed = await this.tools.describeProductOptionsById(input.tenantId, option.productId);
      if (!listed.ok) {
        return {
          replyText: listed.message,
          outbound: { kind: 'text', body: listed.message },
          salesContext,
        };
      }

      const prompt = this.conversationFlow.buildCartActionPrompt(salesContext, listed.message);
      this.rememberFocusedProduct(salesContext, option);
      return {
        ...prompt,
        salesContext: { ...prompt.salesContext, lastOptions: listed.options ?? [], focusedProduct: salesContext.focusedProduct },
      };
    }

    const built = await this.tools.buildOrderItemBySku(input.tenantId, option.sku, quantity, {
      userText: input.text,
    });
    const packMsg = this.capturePackResolution(salesContext, built);
    if (packMsg) {
      return {
        replyText: packMsg,
        outbound: { kind: 'text', body: packMsg },
        salesContext,
      };
    }
    if (!built.ok || !built.item) {
      return this.conversationFlow.buildCartActionPrompt(salesContext, built.message);
    }

    this.addItemsToCart(input, salesContext, [built.item]);
    const qtyLabel = quantity > 1 ? `${quantity} de ` : '';
    const intro = `${warmAddedOpener(option.sku)} Agregué ${qtyLabel}*${built.item.name}* a tu pedido ${EMOJI.cart}`;
    const prompt = this.conversationFlow.buildCartActionPrompt(salesContext, intro);
    return {
      ...prompt,
      salesContext: { ...prompt.salesContext, lastOptions: salesContext.lastOptions },
    };
  }

  private addItemsToCart(
    input: { customerPhone: string },
    salesContext: SalesContext,
    newItems: OrderItem[],
    customerNameArg?: unknown
  ): string {
    const customerName = String(
      customerNameArg ?? salesContext.customerName ?? input.customerPhone
    ).trim();
    const merged = CartService.merge(salesContext.cartItems, newItems);

    Object.assign(salesContext, {
      phase: 'browsing' as const,
      flowStep: 'buying' as const,
      cartItems: merged,
      customerName,
      lastAddedSkus: newItems.map((item) => item.sku),
      lastCheckoutUrl: undefined,
      pendingPackQuote: undefined,
      pendingPackProduct: undefined,
      pendingProductPage: undefined,
    });
    this.rememberFocusedProduct(salesContext, newItems[newItems.length - 1]);

    const summary = CartService.formatSummary(merged);
    return [
      'Producto(s) agregado(s) al carrito:',
      summary,
      '',
      'Indica al cliente el resumen y pregúntale: *¿Deseas agregar algo más o eso sería todo?*',
      'NO menciones transferencia, Bre-B ni método de pago todavía.',
    ].join('\n');
  }

  private mergeCartItems(existing: PendingCartItem[] | undefined, newItems: OrderItem[]): PendingCartItem[] {
    return CartService.merge(existing, newItems);
  }

  private capturePackResolution(salesContext: SalesContext, resolution: ProductResolution): string | null {
    if (resolution.packQuote) {
      this.storePackQuote(salesContext, resolution.packQuote);
      this.rememberFocusedProduct(salesContext, resolution.packQuote);
      return resolution.message;
    }
    if (resolution.needsQuantity && resolution.packProduct) {
      salesContext.pendingPackProduct = resolution.packProduct;
      salesContext.pendingPackQuote = undefined;
      this.rememberFocusedProduct(salesContext, resolution.packProduct);
      return resolution.message;
    }
    return null;
  }

  private storePackQuote(salesContext: SalesContext, quote: PackQuote): void {
    salesContext.pendingPackQuote = {
      productId: quote.productId,
      sku: quote.sku,
      productName: quote.productName,
      unitLabel: quote.unitLabel,
      unitPlural: quote.unitPlural,
      desiredUnits: quote.desiredUnits,
      tiers: quote.tiers,
    };
    salesContext.pendingPackProduct = undefined;
    this.rememberFocusedProduct(salesContext, quote);
  }

  private applyPackSelection(
    input: { customerPhone: string },
    salesContext: SalesContext,
    selection: ProductResolutionBatch,
    options: { addExtraItems?: boolean } = {}
  ): ConversationFlowResult | null {
    const { addExtraItems = true } = options;
    if (selection.items?.length && !selection.packQuotes?.length && !selection.needsQuantity) {
      return null;
    }

    if (selection.needsQuantity && selection.packProduct) {
      salesContext.pendingPackProduct = selection.packProduct;
      salesContext.pendingPackQuote = undefined;
      this.rememberFocusedProduct(salesContext, selection.packProduct);
      return {
        replyText: selection.message,
        outbound: { kind: 'text', body: selection.message },
        salesContext,
      };
    }

    if (selection.packQuotes?.length) {
      if (addExtraItems && selection.items?.length) {
        this.addItemsToCart(input, salesContext, selection.items);
      }
      const quote = selection.packQuotes[0]!;
      this.storePackQuote(salesContext, quote);
      const extra = selection.packQuotes.slice(1).map((row) => formatPackQuoteMessage(row));
      const body = [selection.message || formatPackQuoteMessage(quote), ...extra].filter(Boolean).join('\n\n');
      return {
        replyText: body,
        outbound: { kind: 'text', body },
        salesContext,
      };
    }

    return null;
  }

  private rememberFocusedProduct(
    salesContext: SalesContext,
    product: { productId?: number; name?: string; sku?: string; productName?: string } | undefined
  ): void {
    if (!product?.productId) return;
    const name = (product.name || product.productName || '').trim();
    if (!name) return;
    salesContext.focusedProduct = {
      productId: product.productId,
      name,
      sku: product.sku?.trim() || undefined,
    };
  }

  /** "info A" sobre un tipo de balín abre sus tamaños, no la ficha de un solo producto. */
  private balinTypeFromInfoRequest(salesContext: SalesContext, text: string): OfferedOption | null {
    const listed = salesContext.lastOptions;
    if (!listed?.length) return null;
    const reference = stripProductPageWords(text) || text;
    const chosen = findOfferedOption(reference, listed);
    if (!chosen) return null;
    const option = listed[chosen.index];
    return option?.memberProductIds && option.memberProductIds.length > 1 ? option : null;
  }

  private resolveProductForPage(salesContext: SalesContext, text: string): FocusedProduct | null {
    // "info B" o "info HRPALM001": sin quitar las palabras de la petición, el resolutor
    // intenta casar "info" contra los nombres del listado y no encuentra nada.
    const reference = stripProductPageWords(text) || text;
    const listed = salesContext.lastOptions;

    if (listed?.length) {
      const chosen = findOfferedOption(reference, listed);
      if (chosen) {
        const option = listed[chosen.index]!;
        return { productId: option.productId, name: option.name, sku: option.sku };
      }
    }

    // Un *ID* que no salió en el último listado igual identifica al producto en la tienda.
    const [sku] = extractExplicitSkus(reference);
    if (sku) return { productId: 0, name: '', sku };

    if (salesContext.focusedProduct) return salesContext.focusedProduct;
    if (salesContext.pendingPackQuote) {
      return {
        productId: salesContext.pendingPackQuote.productId,
        name: salesContext.pendingPackQuote.productName,
        sku: salesContext.pendingPackQuote.sku,
      };
    }
    if (salesContext.pendingPackProduct) {
      return {
        productId: salesContext.pendingPackProduct.productId,
        name: salesContext.pendingPackProduct.name,
        sku: salesContext.pendingPackProduct.sku,
      };
    }
    if (listed?.length === 1) {
      const only = listed[0]!;
      return { productId: only.productId, name: only.name, sku: only.sku };
    }
    return null;
  }

  private async sendProductPageLink(
    input: SalesAgentMessageInput,
    salesContext: SalesContext,
    product: FocusedProduct
  ): Promise<ConversationFlowResult> {
    const page = await this.tools.resolveProductPageDetails(input.tenantId, product);
    if (!page) {
      const body = formatProductPageMissing();
      return { replyText: body, outbound: { kind: 'text', body }, salesContext };
    }

    const name = page.name || product.name;
    this.rememberFocusedProduct(salesContext, { ...product, name });

    const body = formatProductPageLink(name, page);
    return {
      replyText: body,
      outbound: page.imageUrl
        ? { kind: 'image', body, imageUrl: page.imageUrl }
        : { kind: 'text', body },
      salesContext,
    };
  }

  private async handleProductPageTurn(
    input: SalesAgentMessageInput,
    salesContext: SalesContext,
    text: string
  ): Promise<ConversationFlowResult | null> {
    if (salesContext.flowStep === 'checkout_redirect') return null;
    if (!isProductPageInfoIntent(text)) return null;

    const typeGroup = this.balinTypeFromInfoRequest(salesContext, text);
    if (typeGroup) {
      const expanded = await this.tools.describeMemberProducts(input.tenantId, typeGroup);
      if (!expanded.ok) {
        return { replyText: expanded.message, outbound: { kind: 'text', body: expanded.message }, salesContext };
      }
      return {
        replyText: expanded.message,
        outbound: { kind: 'text', body: expanded.message },
        salesContext: { ...salesContext, lastOptions: expanded.options ?? [] },
      };
    }

    const product = this.resolveProductForPage(salesContext, text);
    if (!product) {
      const body = formatProductPageNeedChoice();
      return { replyText: body, outbound: { kind: 'text', body }, salesContext };
    }

    // Preguntar «¿te mando el enlace?» solo añade un turno: el cliente ya pidió la ficha.
    return this.sendProductPageLink(input, salesContext, product);
  }

  private async handlePendingPackTurn(
    input: SalesAgentMessageInput,
    salesContext: SalesContext,
    text: string
  ): Promise<ConversationFlowResult | null> {
    const pendingQuote = salesContext.pendingPackQuote;
    const pendingProduct = salesContext.pendingPackProduct;
    if (!pendingQuote && !pendingProduct) return null;

    if (isPackQuoteRejectIntent(text)) {
      salesContext.pendingPackQuote = undefined;
      salesContext.pendingPackProduct = undefined;
      const body = 'Listo, no lo agregué. Dime el *ID* o la cantidad si quieres otro producto.';
      return { replyText: body, outbound: { kind: 'text', body }, salesContext };
    }

    if (
      !extractDesiredUnits(text) &&
      (isMenuGreeting(text) ||
        shouldAbandonPendingPackFlow(text) ||
        isProductPageInfoIntent(text))
    ) {
      salesContext.pendingPackQuote = undefined;
      salesContext.pendingPackProduct = undefined;
      return null;
    }

    const pendingRef = pendingQuote ?? pendingProduct;
    const pendingName = pendingQuote?.productName ?? pendingProduct?.name ?? '';
    if (
      pendingRef &&
      pendingName &&
      mentionsDifferentPackProduct(text, { sku: pendingRef.sku, name: pendingName })
    ) {
      salesContext.pendingPackQuote = undefined;
      salesContext.pendingPackProduct = undefined;
      return null;
    }

    const newUnits = extractDesiredUnits(text);
    // "sí, agrégame los 7" repite la cantidad ya cotizada: es confirmación, no una cotización nueva.
    const repeatsQuotedQuantity = pendingQuote != null && newUnits === pendingQuote.desiredUnits;
    const pendingSku = (pendingQuote?.sku ?? pendingProduct?.sku ?? '').toUpperCase();
    // "agrega BLD3AM003" con otra cotización pendiente pide otro producto, no confirma esta.
    const mentionsOtherSku = extractExplicitSkus(text).some((sku) => sku.toUpperCase() !== pendingSku);
    const addsQuoted = !mentionsOtherSku && isPackQuoteAddIntent(text);
    // Con producto pendiente, cualquier cantidad dispara la cotización (p. ej. «quisiera 18 balines»).
    if (newUnits && !repeatsQuotedQuantity && !mentionsOtherSku && (pendingProduct || pendingQuote)) {
      const sku = pendingQuote?.sku ?? pendingProduct!.sku;
      const built = await this.tools.buildOrderItemBySku(input.tenantId, sku, newUnits, { userText: text });
      const packMsg = this.capturePackResolution(salesContext, built);
      if (packMsg) {
        return { replyText: packMsg, outbound: { kind: 'text', body: packMsg }, salesContext };
      }
    }

    if (pendingQuote && (isPackQuoteConfirmIntent(text) || addsQuoted || isCartFinalizeIntent(text))) {
      const quote = this.hydratePackQuote(pendingQuote);
      if (!quote) {
        const body = 'No pude armar esa combinación. Prueba con otra cantidad.';
        return { replyText: body, outbound: { kind: 'text', body }, salesContext };
      }
      const items = packQuoteToOrderItems(quote);
      this.addItemsToCart(input, salesContext, items);
      if (isCartFinalizeIntent(text) && (salesContext.cartItems?.length ?? 0) > 0) {
        return null;
      }
      const intro = this.buildAddedIntroLine(items);
      return this.conversationFlow.buildCartActionPrompt(salesContext, intro);
    }

    if (pendingProduct && !newUnits && !isProductSelectionIntent(text) && !hasConcreteProductSpec(text)) {
      const body = formatPackQuantityPrompt(pendingProduct.name, {
        unitLabel: pendingProduct.unitLabel,
        unitPlural: pendingProduct.unitPlural,
      });
      return { replyText: body, outbound: { kind: 'text', body }, salesContext };
    }

    return null;
  }

  private hydratePackQuote(pending: PendingPackQuote): PackQuote | null {
    const composition = composePacks(pending.desiredUnits, pending.tiers);
    if (!composition) return null;
    return { ...pending, composition };
  }

  private async finalizeCart(
    input: SalesAgentMessageInput,
    salesContext: SalesContext,
    businessProfile?: {
      checkoutFormUrl?: string;
      checkoutMode?: 'link' | 'whatsapp';
      bankAccountInfo?: string;
    }
  ): Promise<{
    message: string;
    enteredPaymentSelect: boolean;
    enteredCheckoutLink?: boolean;
    checkoutUrl?: string;
  }> {
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
    const checkoutMode = businessProfile?.checkoutMode ?? 'link';
    const total = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const summary = this.conversationFlow.formatCartSummary(items);

    if (checkoutMode === 'link') {
      const link = await this.tools.buildCheckoutFormLink(
        input.tenantId,
        input.customerPhone,
        items,
        businessProfile
      );
      if (!link.ok || !link.url) {
        return { message: link.message, enteredPaymentSelect: false, enteredCheckoutLink: false };
      }

      Object.assign(salesContext, {
        phase: 'browsing' as const,
        flowStep: 'checkout_redirect' as const,
        cartItems: [],
        lastOptions: undefined,
        lastAddedSkus: undefined,
        lastCheckoutUrl: link.url,
        customerName,
      });

      return {
        message: ['Carrito confirmado. Se enviará enlace al formulario de compra.', summary].join('\n'),
        enteredPaymentSelect: false,
        enteredCheckoutLink: true,
        checkoutUrl: link.url,
      };
    }

    if (massiEnabled && checkoutMode === 'whatsapp') {
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

  private parseRequestedSkus(raw: unknown): { sku: string; quantity: number }[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => {
        const row = entry as Record<string, unknown>;
        const quantity = Number(row.cantidad ?? row.quantity ?? 1);
        return {
          sku: String(row.sku ?? '').trim(),
          quantity: Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1,
        };
      })
      .filter((row) => row.sku.length > 0);
  }

  /**
   * El cliente solo puede recibir tantas variaciones de un mismo producto como medidas
   * haya nombrado. Sin este límite, un "el primero" acababa con seis tallas del mismo
   * anillo en el carrito porque el modelo agregaba todo lo que devolvía el RAG.
   */
  private guardVariationFlood(
    userText: string,
    items: OrderItem[],
    addedThisTurn: Map<number, number>
  ): string | null {
    const allowedPerParent = Math.max(1, extractAllVariantHints(userText).length);
    const counts = new Map(addedThisTurn);

    for (const item of items) {
      const total = (counts.get(item.productId) ?? 0) + 1;
      counts.set(item.productId, total);

      if (total > allowedPerParent) {
        const parentName = item.name.split(' - ')[0]?.trim() || item.name;
        return [
          `No agregues varias opciones de "${parentName}" sin que el cliente elija una.`,
          'Lista las opciones con su *ID* y espera a que indique cuál quiere.',
        ].join(' ');
      }
    }

    for (const [productId, total] of counts) addedThisTurn.set(productId, total);
    return null;
  }

  private buildSystemPrompt(input: {
    businessName: string;
    businessProfile?: {
      description?: string;
      address?: string;
      businessHours?: string;
      bankAccountInfo?: string;
      checkoutFormUrl?: string;
      checkoutMode?: 'link' | 'whatsapp';
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
          : input.flowStep === 'checkout_redirect'
            ? 'FASE ACTUAL: ya se envió enlace al formulario WC. Si pide el link → finalizar_compra. NO uses botones de pago en chat.'
            : input.flowStep === 'buying'
              ? `FASE ACTUAL: carrito con ${input.cartItemCount} producto(s). El cliente cierra con el botón o escribiendo *Finalizar pedido*; todo lo demás lo maneja por texto. Si agrega o cambia productos, usa agregar_producto_por_sku. NO llames finalizar_compra salvo confirmación explícita.`
              : input.flowStep === 'discovery' || input.flowStep === 'menu'
                ? 'FASE ACTUAL: esperando ID de producto o descripción en lenguaje natural. El sistema intenta RAG→SKU automáticamente; si el LLM interviene, usa buscar_en_documentos para interpretar y luego agregar_producto_por_sku con el SKU. Si sigue sin haber un SKU claro, pide el ID en vez de proponer opciones.'
                : 'FASE ACTUAL: exploración y venta.';

    return [
      `Eres el asistente de ventas por WhatsApp de "${input.businessName}".`,
      'Responde en español, cálido y conciso (máximo 3 párrafos). Usa 1 o 2 emojis por mensaje',
      'para que suene cercano (💎 ✨ 🛒 😊) y varía tus frases: no repitas siempre la misma.',
      'FLUJO DE VENTA:',
      '1) Si el cliente escribe hola/menú, el sistema ya envió el saludo de bienvenida; no repitas otro saludo genérico.',
      '2) El cliente puede enviar el *ID del producto* (SKU) o describirlo en lenguaje natural (ej. "balín diamantado #6", "cadena de oro 50 cm").',
      '3) Para interpretar descripciones: buscar_en_documentos (RAG del catálogo) → extrae SKU → agregar_producto_por_sku. El backend también intenta RAG→SKU antes del LLM.',
      '4) PROHIBIDO sugerir productos al azar. Catálogo general → enlace; tipo concreto (cadena, anillo…) → el sistema lista variantes del producto padre en WC con *ID* visible.',
      '4b) Si el cliente nombra un producto que tiene varias tallas/medidas SIN elegir una, NUNCA agregues nada: lista sus opciones con su *ID* y espera su elección. Agregar todas las variaciones de un producto es un error grave.',
      '4e) Etiqueta las opciones de una lista con LETRAS (A, B, C…), nunca con números: los productos ya se llaman por número (*Balín #6*, tallas) y el cliente se confunde.',
      '4c) Nunca menciones precios que no vengan de WooCommerce en este turno. Si no tienes el precio, no escribas "a consultar": consulta con las herramientas o pide el *ID*.',
      '4d) Si el cliente PREGUNTA disponibilidad ("tienen…", "hay…", "venden…") NUNCA agregues al carrito: lista opciones con *ID* y espera a que elija o diga "quiero".',
      '5) Stock y precios: SIEMPRE WooCommerce por SKU/ID (verificar_stock, agregar_producto_por_sku). NUNCA inventes productos ni precios desde RAG.',
      '5b) Productos a granel (balines y similares): NO agregues N unidades al precio unitario. El backend cotiza paquetes x10/x5/x2/x1 y espera confirmación del cliente. Si pregunta cuánto le sale una cantidad, muestra la cotización del backend y pídele que confirme antes de agregarla.',
      '5c) Fotos/ficha web: el backend manda la foto y el enlace de WooCommerce cuando el cliente pide *info*. NO inventes URLs, descripciones ni fotos: si te piden detalle de un producto, dile que escriba *info* y su letra o su *ID*.',
      '6) IDENTIFICADOR PRINCIPAL: ID = SKU interno. Al cliente siempre dile *ID*, nunca "SKU".',
      '7) Tras agregar al carrito, muestra el resumen e invítalo a enviar otro *ID* o a pulsar *Finalizar pedido* (botón o texto).',
      '8) Cuando confirme que terminó → finalizar_compra: valida stock y envía enlace al formulario WooCommerce.',
      '9) NUNCA digas que un producto no existe si no llamaste a las herramientas de tienda en este turno.',
      '10) Usa la menor cantidad de herramientas posible por mensaje.',
      'Tu trabajo es armar el carrito. No inventes productos ni precios.',
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
    outbound?: OutboundWhatsAppPayload;
    uiRoute?: BbcUiRoute;
    now: string;
    ragHits: number;
    /**
     * Listado de ESTE mensaje. Si viene, reemplaza el anterior. Si se omite, se conserva
     * el de la sesión: el cliente sigue pudiendo elegir por letra o ID.
     */
    listedOptions?: OfferedOption[];
  }): Promise<BbcWebhookAgentResponse> {
    const listed = params.listedOptions?.length ? params.listedOptions : undefined;
    const sameProductList =
      !!listed && listed.every((row) => row.productId === listed[0]!.productId);
    // Un listado nuevo con varios productos deja de apuntar a uno concreto: «mándame la
     // foto» después de listar ocho opciones no puede resolverse sola.
    const salesContext: SalesContext = {
      ...params.salesContext,
      lastOptions: listed ?? params.salesContext.lastOptions,
      focusedProduct:
        listed && listed.length > 1 && !sameProductList
          ? undefined
          : params.salesContext.focusedProduct,
    };

    const updatedMessages: ChatMessage[] = [
      ...params.history,
      { role: 'user', content: params.userText, at: params.now },
      { role: 'assistant', content: params.reply, at: params.now },
    ];

    await this.chatRepo.save({
      tenantId: params.tenantId,
      customerPhone: params.customerPhone,
      messages: updatedMessages,
      salesContext,
      updatedAt: params.now,
    });

    const outbound = params.outbound ?? { kind: 'text' as const, body: params.reply };
    const useCloudRelay = resolveBuilderBotApiMode() === 'cloud-v2';

    if (useCloudRelay) {
      const route = params.uiRoute ?? resolveBbcUiRoute(outbound);
      const phone = normalizeBuilderBotPhone(params.customerPhone);

      await this.dispatchOutbound(params.deviceId, phone, outbound, route);

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
          bbcRoute: route,
        },
      });

      logger.info(
        {
          tenantId: params.tenantId,
          customerPhone: params.customerPhone,
          salesPhase: params.salesContext.phase,
          bbcRoute: route,
        },
        'Agente de ventas respondió por WhatsApp (API v2)'
      );

      return { route };
    }

    const phone = normalizeBuilderBotPhone(params.customerPhone);

    await this.dispatchOutbound(params.deviceId, phone, outbound);

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

  /** Envía uno o varios mensajes WhatsApp en orden (botones y CTA no caben en el mismo mensaje). */
  private async dispatchOutbound(
    deviceId: string,
    phone: string,
    outbound: OutboundWhatsAppPayload,
    route: BbcUiRoute = 'none'
  ): Promise<void> {
    const messages = Array.isArray(outbound) ? outbound : [outbound];
    const interactive = this.builderBot.supportsInteractiveMessages();

    for (const message of messages) {
      // La foto no depende de los mensajes interactivos: el adaptador ya degrada a texto
      // cuando el transporte no acepta media, y el pie lleva el enlace de la ficha.
      if (message.kind === 'image') {
        await this.builderBot.sendImageMessage({
          deviceId,
          phone,
          imageUrl: message.imageUrl,
          caption: message.body,
        });
        continue;
      }

      if (!interactive) {
        const text = this.renderOutboundAsText(message, route);
        if (text) await this.builderBot.sendTextMessage({ deviceId, phone, message: text });
        continue;
      }

      if (message.kind === 'buttons') {
        await this.builderBot.sendButtonsMessage({
          deviceId,
          phone,
          body: message.body,
          footer: message.footer,
          buttons: message.buttons,
        });
        continue;
      }

      if (message.kind === 'cta_url') {
        if (message.body.trim()) {
          await this.builderBot.sendTextMessage({ deviceId, phone, message: message.body });
        }
        await this.builderBot.sendCtaUrlMessage({
          deviceId,
          phone,
          body: message.ctaBody?.trim() || CATALOG_CTA_LABEL,
          displayText: message.displayText,
          url: message.url,
          footer: message.footer,
        });
        continue;
      }

      await this.builderBot.sendTextMessage({ deviceId, phone, message: message.body });
    }
  }

  /**
   * Sin mensajes interactivos, las opciones y el enlace viajan dentro del texto. Se omiten
   * cuando el flow UI de BuilderBot ya va a mostrarlos como botones, para no duplicarlos.
   */
  private renderOutboundAsText(message: OutboundWhatsAppMessage, route: BbcUiRoute): string {
    if (message.kind === 'buttons') {
      const flowShowsFinalize =
        route === 'finalize' &&
        message.buttons.every(
          (btn) => btn.id === WA_BTN.CART_FINALIZE || btn.body.trim() === WA_BTN_LABEL.CART_FINALIZE
        );
      const options =
        route === 'cart' || flowShowsFinalize ? '' : renderButtonOptions(message.buttons);
      return joinTextBlocks([message.body, options, message.footer]);
    }

    if (message.kind === 'cta_url') {
      // En `cart` el flow del saludo con carrito encadena el del catálogo (gotoFlow).
      const flowShowsCatalog = route === 'catalog' || route === 'cart';
      const link = flowShowsCatalog ? '' : renderLinkBlock(message.displayText, message.url, message.ctaBody);
      return joinTextBlocks([message.body, link, message.footer]);
    }

    return message.body.trim();
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
