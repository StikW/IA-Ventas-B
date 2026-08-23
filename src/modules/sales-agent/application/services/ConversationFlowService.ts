import { inject, injectable } from 'tsyringe';
import { BuilderBotButtonOption } from '../../../builderbot/domain/IBuilderBotCloudService';
import { IWooCommerceConfigRepository, IWooCommerceService } from '../../../woocommerce/domain/IWooCommerceService';
import { IConfigRepository } from '../../../tenant/domain/repositories/IConfigRepository';
import { BusinessProfileConfig } from '../../../tenant/domain/entities/Config.types';
import { BbcUiRoute } from '../../../builderbot/domain/BbcWebhookAgentResponse';
import { SalesContext } from '../../domain/IChatSessionRepository';
import { CATALOG_CTA_LABEL, resolveStoreCatalogUrl } from '../../domain/catalogUrl.utils';
import { EMOJI, warmMorePrompt } from '../../domain/tone.utils';
import {
  CHECKOUT_CTA_LABEL,
  isCartContinueShoppingIntent,
  isCartFinalizeIntent,
  isMenuGreeting,
  resolveButtonAction,
  resolvePaymentMethodChoice,
  WA_BTN,
  WA_BTN_LABEL,
} from '../../domain/whatsappFlow.constants';
import { SalesAgentToolsHandler } from './SalesAgentToolsHandler';
import { CartService } from './CartService';

export type OutboundWhatsAppMessage =
  | { kind: 'text'; body: string }
  | {
      kind: 'buttons';
      body: string;
      footer?: string;
      buttons: BuilderBotButtonOption[];
    }
  | {
      kind: 'cta_url';
      /** Texto que se envía como mensaje previo. Vacío = solo se envía el mensaje con el botón. */
      body: string;
      /** Texto del mensaje que lleva el botón. Por defecto, la etiqueta del CTA. */
      ctaBody?: string;
      displayText: string;
      url: string;
      footer?: string;
    };

/** WhatsApp no permite mezclar botones de respuesta y botón de enlace en un mismo mensaje. */
export type OutboundWhatsAppPayload = OutboundWhatsAppMessage | OutboundWhatsAppMessage[];

export interface ConversationFlowInput {
  tenantId: string;
  customerPhone: string;
  text: string;
  businessName: string;
  businessProfile?: BusinessProfileConfig;
  salesContext: SalesContext;
  historyLength: number;
}

export interface ConversationFlowResult {
  replyText: string;
  outbound: OutboundWhatsAppPayload;
  salesContext: SalesContext;
  /** Flow UI de BuilderBot a ejecutar tras estos mensajes. Si falta, se infiere del outbound. */
  uiRoute?: BbcUiRoute;
}

@injectable()
export class ConversationFlowService {
  constructor(
    @inject('IWooCommerceConfigRepository') private readonly wcConfigRepo: IWooCommerceConfigRepository,
    @inject('IWooCommerceService') private readonly wcService: IWooCommerceService,
    @inject('IConfigRepository') private readonly configRepo: IConfigRepository,
    @inject(SalesAgentToolsHandler) private readonly tools: SalesAgentToolsHandler
  ) {}

  /**
   * Saludo de bienvenida (texto) y selección de método de pago (botones BBC).
   */
  async tryHandle(input: ConversationFlowInput): Promise<ConversationFlowResult | null> {
    const text = input.text.trim();
    if (!text) return null;

    const action = resolveButtonAction(text);

    if (input.salesContext.phase === 'awaiting_payment' && (action === WA_BTN.MENU_BACK || isMenuGreeting(text))) {
      return {
        replyText:
          'Estamos esperando tu comprobante de pago. Envía la captura por este chat. Escribe *menú* cuando termines.',
        outbound: {
          kind: 'text',
          body: 'Estamos esperando tu comprobante de pago. Envía la captura por este chat.',
        },
        salesContext: input.salesContext,
      };
    }

    if (input.salesContext.flowStep !== 'payment_select' && input.salesContext.phase !== 'awaiting_payment') {
      const menuResult = await this.tryHandleMenuAndCartButtons(input, action);
      if (menuResult) return menuResult;
    }

    if (
      isMenuGreeting(text) &&
      input.salesContext.flowStep !== 'payment_select' &&
      input.salesContext.phase !== 'awaiting_payment'
    ) {
      return this.buildWelcomeMessage(input.tenantId, input.businessName, input.businessProfile, input.salesContext);
    }

    if (input.salesContext.flowStep === 'buying' && isCartFinalizeIntent(text)) {
      return null;
    }

    if (input.salesContext.flowStep === 'buying' && isCartContinueShoppingIntent(text)) {
      return this.buildProductIdPrompt(
        input.tenantId,
        input.salesContext,
        '¡Claro! Sigamos armando tu pedido.'
      );
    }

    if (input.salesContext.flowStep === 'checkout_redirect') {
      if (isMenuGreeting(text)) {
        return this.buildWelcomeMessage(input.tenantId, input.businessName, input.businessProfile, input.salesContext);
      }
      if (isCartFinalizeIntent(text) || /formulario|link|enlace|checkout|completar\s+(la\s+)?compra/i.test(text)) {
        return null;
      }
    }

    if (input.salesContext.flowStep !== 'payment_select') {
      return null;
    }

    // Saludo u otro tema durante selección de pago → lo maneja el agente (sesión ya limpiada arriba).
    if (isMenuGreeting(text)) {
      return null;
    }

    const massiEnabled = await this.tools.massiBotEnabled(input.tenantId);
    const paymentAction = action ?? resolvePaymentMethodChoice(text);

    if (paymentAction) {
      if (!massiEnabled || !input.salesContext.cartItems?.length) {
        return this.cancelPaymentSelection(
          'No pudimos continuar con el pago. Cuéntame qué producto buscas y te ayudo.'
        );
      }
      return this.handlePaymentSelection(input, paymentAction);
    }

    const total = input.salesContext.cartItems?.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const totalHint = total ? `Total estimado: *$${total.toLocaleString('es-CO')}*` : undefined;
    return this.buildPaymentMethodPrompt(input.salesContext, totalHint);
  }

  /** Descripción, dirección y horario del negocio (se editan en `/business/settings`). */
  private formatBusinessProfileBlock(profile?: BusinessProfileConfig): string[] {
    const lines = [
      profile?.description?.trim() ? `✨ ${profile.description.trim()}` : null,
      profile?.address?.trim() ? `📍 ${profile.address.trim()}` : null,
      profile?.businessHours?.trim() ? `🕐 ${profile.businessHours.trim()}` : null,
    ];

    return lines.filter((line): line is string => !!line);
  }

  private async resolveCatalogUrl(tenantId: string): Promise<string | null> {
    const wcConfig = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!wcConfig?.storeUrl) return null;

    let shopPagePath = wcConfig.shopPagePath;
    if (!shopPagePath && wcConfig.connected) {
      try {
        shopPagePath = (await this.wcService.resolveShopPagePath(wcConfig)) ?? undefined;
      } catch {
        shopPagePath = undefined;
      }
    }

    return resolveStoreCatalogUrl(wcConfig.storeUrl, shopPagePath);
  }

  async buildWelcomeMessage(
    tenantId: string,
    businessName: string,
    profile?: BusinessProfileConfig,
    previousContext?: SalesContext
  ): Promise<ConversationFlowResult> {
    const profileLines = this.formatBusinessProfileBlock(profile);
    const intro = [
      `¡Hola! 👋 Qué gusto tenerte en *${businessName}*.`,
      profileLines.length ? '' : null,
      ...profileLines,
      '',
      'Soy tu asesor por WhatsApp: te ayudo a elegir, armo tu pedido y te acompaño hasta finalizar la compra 😊',
    ]
      .filter((line) => line !== null)
      .join('\n');
    const salesContext = previousContext ?? { phase: 'browsing' };

    if (salesContext.cartItems?.length) {
      return this.buildWelcomeWithCart(tenantId, intro, salesContext);
    }

    return this.buildProductIdPrompt(tenantId, salesContext, intro);
  }

  /** Saludo cuando el cliente vuelve con carrito: resumen + acciones + enlace al catálogo. */
  private async buildWelcomeWithCart(
    tenantId: string,
    intro: string,
    salesContext: SalesContext
  ): Promise<ConversationFlowResult> {
    const items = salesContext.cartItems ?? [];
    const catalogUrl = await this.resolveCatalogUrl(tenantId);

    // Las opciones (vaciar, modificar, catálogo) las explica el flow BBC que llega después.
    const body = [
      intro,
      '',
      '🛒 Tienes un pedido en curso:',
      CartService.formatSummary(items),
      '',
      'Para cerrar la compra, escribe *Finalizar pedido*.',
    ].join('\n');

    const messages: OutboundWhatsAppMessage[] = [
      {
        kind: 'buttons',
        body,
        buttons: [
          { id: WA_BTN.CART_FINALIZE, body: WA_BTN_LABEL.CART_FINALIZE },
          { id: WA_BTN.CART_CLEAR, body: WA_BTN_LABEL.CART_CLEAR },
        ],
      },
    ];

    if (catalogUrl) {
      messages.push({
        kind: 'cta_url',
        body: '',
        ctaBody: 'Si quieres ver más productos, revisa el catálogo:',
        displayText: CATALOG_CTA_LABEL,
        url: catalogUrl,
      });
    }

    const replyText = catalogUrl ? `${body}\n\n${CATALOG_CTA_LABEL}: ${catalogUrl}` : body;

    return {
      replyText,
      outbound: messages,
      uiRoute: 'cart',
      salesContext: { ...salesContext, phase: 'browsing', flowStep: 'buying' },
    };
  }

  /** Pide ID de producto (SKU) y ofrece enlace al catálogo WC con botón CTA. */
  async buildProductIdPrompt(
    tenantId: string,
    salesContext: SalesContext,
    introBlock?: string
  ): Promise<ConversationFlowResult> {
    const catalogUrl = await this.resolveCatalogUrl(tenantId);

    const idPrompt = [
      '🛍️ *¿Cómo seguimos?*',
      '',
      '1️⃣ Arma tu pedido en el *catálogo de WhatsApp* y envíamelo: lo cargo en tu carrito al instante.',
      '2️⃣ Si ya viste algo (en la tienda o en WhatsApp), envíame el *ID del producto* y lo agrego.',
      '3️⃣ Si no lo tienes a mano, descríbeme lo que buscas (por ejemplo: _una cadena, anillo, balín, etc..._) y yo lo busco por ti.',
      '',
      'Y si prefieres mirar con calma en la web, aquí abajo te dejo el catálogo oficial 👇',
    ].join('\n');

    const body = [introBlock, introBlock ? '' : null, idPrompt].filter((line) => line !== null).join('\n');

    return this.buildCatalogCtaResult(body, catalogUrl, salesContext);
  }

  /** Cuando no se identifica el producto: pedir el ID y remitir al catálogo (nunca sugerir opciones). */
  async buildProductLookupHelpReply(
    tenantId: string,
    salesContext: SalesContext
  ): Promise<ConversationFlowResult> {
    const catalogUrl = await this.resolveCatalogUrl(tenantId);
    const items = salesContext.cartItems ?? [];

    const body = [
      'Quiero agregarte justo lo que buscas, así que necesito el *ID del producto* 🙌',
      '',
      'Lo verás junto a cada producto en la tienda: envíamelo por aquí y lo sumo a tu pedido.',
      items.length ? '' : null,
      items.length ? '🛒 Por ahora tu pedido va así:' : null,
      items.length ? CartService.formatSummary(items) : null,
    ]
      .filter((line) => line !== null)
      .join('\n');

    return this.buildCatalogCtaResult(body, catalogUrl, salesContext);
  }

  /** Respuesta a consultas de catálogo: enlace + botón (no lista de productos en chat). */
  async buildCatalogBrowseReply(tenantId: string, salesContext: SalesContext): Promise<ConversationFlowResult> {
    const catalogUrl = await this.resolveCatalogUrl(tenantId);
    const body =
      '¡Con gusto! 😊 Aquí puedes ver todos nuestros productos disponibles, con fotos, precios y el *ID* de cada uno.\n\nCuando encuentres el que te guste, envíame su *ID* por aquí y lo agrego a tu pedido.';

    return this.buildCatalogCtaResult(body, catalogUrl, {
      ...salesContext,
      phase: 'browsing',
      flowStep: 'discovery',
    });
  }

  private buildCatalogCtaResult(
    body: string,
    catalogUrl: string | null,
    salesContext: SalesContext
  ): ConversationFlowResult {
    const outbound: OutboundWhatsAppMessage =
      catalogUrl ?
        {
          kind: 'cta_url',
          body,
          displayText: CATALOG_CTA_LABEL,
          url: catalogUrl,
        }
      : { kind: 'text', body };

    const replyText = catalogUrl ? `${body}\n\n${CATALOG_CTA_LABEL}: ${catalogUrl}` : body;

    return {
      replyText,
      outbound,
      uiRoute: 'catalog',
      salesContext: {
        ...salesContext,
        phase: 'browsing',
        flowStep: 'discovery',
        cartItems: salesContext.cartItems,
        customerName: salesContext.customerName,
      },
    };
  }

  /**
   * Tras agregar o modificar el carrito. El cliente sigue conversando en texto libre;
   * el único botón es el cierre de compra.
   */
  buildCartActionPrompt(salesContext: SalesContext, introLine: string): ConversationFlowResult {
    const items = salesContext.cartItems ?? [];

    // Un listado de opciones ya pide el ID y trae su propio cierre; añadirle el resumen
    // del carrito y otra petición de ID producía mensajes de veinte líneas repetidas.
    const introAsksForId = /\*ID\*/.test(introLine);
    const introIsStoreError = /error al consultar|no pude consultar|intenta de nuevo|no est[aá] conectado/i.test(
      introLine
    );

    if (!items.length) {
      const emptyBody = introAsksForId || introIsStoreError
        ? introLine
        : [introLine, '', `Envíame el *ID* del producto que te interesa ${EMOJI.sparkle}`]
            .filter(Boolean)
            .join('\n');
      return {
        replyText: emptyBody,
        outbound: { kind: 'text', body: emptyBody },
        salesContext: { ...salesContext, phase: 'browsing', flowStep: 'discovery' },
      };
    }

    // Un listado de opciones (o un fallo al consultarlo) no cierra la compra.
    if (introAsksForId || introIsStoreError) {
      return {
        replyText: introLine,
        outbound: { kind: 'text', body: introLine },
        salesContext: {
          ...salesContext,
          phase: 'browsing',
          flowStep: items.length ? 'buying' : 'discovery',
        },
      };
    }

    const body = [introLine, '', CartService.formatSummary(items), '', warmMorePrompt(items.length)]
      .filter(Boolean)
      .join('\n');

    return {
      replyText: body,
      outbound: {
        kind: 'buttons',
        body,
        buttons: [{ id: WA_BTN.CART_FINALIZE, body: WA_BTN_LABEL.CART_FINALIZE }],
      },
      uiRoute: 'finalize',
      salesContext: {
        ...salesContext,
        phase: 'browsing',
        flowStep: 'buying',
      },
    };
  }

  formatCartSummary(cartItems: NonNullable<SalesContext['cartItems']>): string {
    return CartService.formatSummary(cartItems);
  }

  /** Tras cerrar carrito en modo `link`: envía URL al formulario WC/MASSI. */
  buildCheckoutLinkReply(
    salesContext: SalesContext,
    checkoutUrl: string,
    customerPhone: string
  ): ConversationFlowResult {
    const cartSummary = salesContext.cartItems?.length
      ? `\n\n${this.formatCartSummary(salesContext.cartItems)}`
      : '';
    const body = [
      '¡Perfecto! Tu selección está lista.',
      cartSummary,
      '',
      'Abre el enlace para completar tu pedido en la tienda: elige recoger en tienda o envío a domicilio y el método de pago.',
      'Tu carrito y tu número (*' + customerPhone.replace(/\D/g, '') + '*) ya van cargados en el formulario.',
      'Cuando termines, recibirás confirmación por correo. Si necesitas ayuda, escríbeme por aquí.',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      replyText: `${body}\n\n${CHECKOUT_CTA_LABEL}: ${checkoutUrl}`,
      outbound: {
        kind: 'cta_url',
        body,
        ctaBody: 'Completa tu compra aquí 👇',
        displayText: CHECKOUT_CTA_LABEL,
        url: checkoutUrl,
      },
      salesContext: {
        ...salesContext,
        phase: 'browsing',
        flowStep: 'checkout_redirect',
      },
    };
  }

  buildPaymentMethodPrompt(salesContext: SalesContext, totalHint?: string): ConversationFlowResult {
    const cartSummary =
      salesContext.cartItems?.length ? `\n\n${this.formatCartSummary(salesContext.cartItems)}` : '';
    const body = [
      'Perfecto. Este es tu pedido:',
      cartSummary,
      totalHint ? `\n${totalHint}` : '',
      '\nElige cómo deseas pagar:',
    ]
      .filter(Boolean)
      .join('');

    return {
      replyText: body,
      outbound: {
        kind: 'buttons',
        body,
        buttons: [
          { id: WA_BTN.PAY_TRANSFER, body: WA_BTN_LABEL.PAY_TRANSFER },
          { id: WA_BTN.PAY_CASH, body: WA_BTN_LABEL.PAY_CASH },
          { id: WA_BTN.MENU_BACK, body: WA_BTN_LABEL.MENU_BACK },
        ],
      },
      salesContext: {
        ...salesContext,
        phase: 'browsing',
        flowStep: 'payment_select',
      },
    };
  }

  private async tryHandleMenuAndCartButtons(
    input: ConversationFlowInput,
    action: string | null
  ): Promise<ConversationFlowResult | null> {
    if (!action) return null;

    if (action === WA_BTN.MENU_BUY) {
      return this.buildProductIdPrompt(
        input.tenantId,
        input.salesContext,
        '¡Perfecto! Sigamos con tu compra.'
      );
    }

    if (action === WA_BTN.MENU_ORDERS) {
      const orders = await this.tools.listMassiOrders(input.tenantId, input.customerPhone);
      return {
        replyText: orders,
        outbound: {
          kind: 'buttons',
          body: orders,
          buttons: [
            { id: WA_BTN.MENU_BUY, body: WA_BTN_LABEL.MENU_BUY },
            { id: WA_BTN.MENU_BACK, body: WA_BTN_LABEL.MENU_BACK },
          ],
        },
        salesContext: {
          ...input.salesContext,
          phase: 'browsing',
          flowStep: 'menu',
        },
      };
    }

    if (action === WA_BTN.MENU_HELP) {
      const profile = input.businessProfile;
      const body = [
        'Te ayudamos con:',
        '· Comprar joyas en oro 18K',
        '· Consultar tu pedido',
        '· Información de la joyería',
        '',
        profile?.address?.trim() ? `📍 ${profile.address.trim()}` : null,
        profile?.businessHours?.trim() ? `🕐 ${profile.businessHours.trim()}` : null,
        '',
        'Escribe *Comprar* para empezar o escríbeme tu pregunta.',
      ]
        .filter(Boolean)
        .join('\n');

      return {
        replyText: body,
        outbound: {
          kind: 'buttons',
          body,
          buttons: [
            { id: WA_BTN.MENU_BUY, body: WA_BTN_LABEL.MENU_BUY },
            { id: WA_BTN.MENU_ORDERS, body: WA_BTN_LABEL.MENU_ORDERS },
            { id: WA_BTN.MENU_BACK, body: WA_BTN_LABEL.MENU_BACK },
          ],
        },
        salesContext: {
          ...input.salesContext,
          phase: 'browsing',
          flowStep: 'help',
        },
      };
    }

    if (action === WA_BTN.MENU_BACK) {
      return this.buildWelcomeMessage(
        input.tenantId,
        input.businessName,
        input.businessProfile,
        input.salesContext
      );
    }

    if (action === WA_BTN.CART_ADD_MORE) {
      return this.buildProductIdPrompt(
        input.tenantId,
        input.salesContext,
        '¿Qué otro producto te gustaría agregar?'
      );
    }

    if (action === WA_BTN.CART_CLEAR) {
      const intro =
        input.salesContext.cartItems?.length ?
          'Listo, vacié tu carrito.'
        : 'Tu carrito ya estaba vacío.';
      return this.buildProductIdPrompt(
        input.tenantId,
        { ...input.salesContext, cartItems: [] },
        intro
      );
    }

    if (action === WA_BTN.CART_FINALIZE) {
      if (!input.salesContext.cartItems?.length) {
        return this.buildProductIdPrompt(
          input.tenantId,
          input.salesContext,
          'Tu carrito está vacío por ahora.'
        );
      }
      return null;
    }

    return null;
  }

  private buildDiscoveryPrompt(salesContext: SalesContext, message: string): ConversationFlowResult {
    return {
      replyText: message,
      outbound: { kind: 'text', body: message },
      salesContext: {
        ...salesContext,
        phase: 'browsing',
        flowStep: 'discovery',
      },
    };
  }

  private cancelPaymentSelection(message: string): ConversationFlowResult {
    return {
      replyText: message,
      outbound: { kind: 'text', body: message },
      salesContext: { phase: 'browsing', flowStep: 'discovery' },
    };
  }

  private async handlePaymentSelection(
    input: ConversationFlowInput,
    action: string
  ): Promise<ConversationFlowResult> {
    const items = input.salesContext.cartItems ?? [];
    const customerName = input.salesContext.customerName ?? input.customerPhone;

    if (action === WA_BTN.MENU_BACK) {
      return this.cancelPaymentSelection(
        'De acuerdo. Si quieres seguir comprando, cuéntame qué producto buscas.'
      );
    }

    const paymentMethod = action === WA_BTN.PAY_CASH ? 'mdp_789' : 'mdp_788';
    const massiOrder = await this.tools.createMassiOrder(
      input.tenantId,
      input.customerPhone,
      customerName,
      items,
      paymentMethod
    );

    if (!massiOrder.ok || !massiOrder.order) {
      return this.cancelPaymentSelection(massiOrder.message);
    }

    const tenantConfig = await this.configRepo.findByTenantId(input.tenantId);
    const bankInfo = tenantConfig?.business?.bankAccountInfo ?? 'Consulta al negocio los datos de pago.';

    if (paymentMethod === 'mdp_789') {
      const body = [
        `Pedido *#${massiOrder.order.orderNumber}* registrado.`,
        massiOrder.order.ticketCode ? `Ticket provisional: *${massiOrder.order.ticketCode}*.` : '',
        'Acércate a la joyería para completar el pago en efectivo y finalizar tu compra.',
        'Cuéntame si necesitas algo más.',
      ]
        .filter(Boolean)
        .join('\n');

      return {
        replyText: body,
        outbound: { kind: 'text', body },
        salesContext: {
          phase: 'order_created',
          lastOrderId: String(massiOrder.order.orderId),
          massiWooOrderId: massiOrder.order.orderId,
          massiWooOrderNumber: massiOrder.order.orderNumber,
          massiTicketCode: massiOrder.order.ticketCode,
          paymentMethod,
        },
      };
    }

    const body = [
      `Pedido *#${massiOrder.order.orderNumber}* registrado.`,
      massiOrder.order.ticketCode ? `Tu ticket: *${massiOrder.order.ticketCode}*.` : '',
      `Datos para transferencia (Bre-B):\n${bankInfo}`,
      'Envía una captura o foto del comprobante por este chat.',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      replyText: body,
      outbound: { kind: 'text', body },
      salesContext: this.tools.buildAwaitingPaymentContext(input.salesContext, items, customerName, {
        orderId: massiOrder.order.orderId,
        orderNumber: massiOrder.order.orderNumber,
        ticketCode: massiOrder.order.ticketCode,
        paymentMethod,
      }),
    };
  }
}
