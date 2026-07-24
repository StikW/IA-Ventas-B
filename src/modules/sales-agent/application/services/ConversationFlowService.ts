import { inject, injectable } from 'tsyringe';
import { BuilderBotButtonOption } from '../../../builderbot/domain/IBuilderBotCloudService';
import { IConfigRepository } from '../../../tenant/domain/repositories/IConfigRepository';
import { BusinessProfileConfig } from '../../../tenant/domain/entities/Config.types';
import { SalesContext } from '../../domain/IChatSessionRepository';
import {
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
    };

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
  outbound: OutboundWhatsAppMessage;
  salesContext: SalesContext;
}

@injectable()
export class ConversationFlowService {
  constructor(
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
      return this.buildWelcomeMessage(input.businessName, input.businessProfile, input.salesContext);
    }

    if (input.salesContext.flowStep === 'buying' && isCartFinalizeIntent(text)) {
      return null;
    }

    if (input.salesContext.flowStep === 'buying' && isCartContinueShoppingIntent(text)) {
      return this.buildDiscoveryPrompt(input.salesContext, '¿Qué más te gustaría agregar a tu pedido? Cuéntame el producto.');
    }

    if (input.salesContext.flowStep === 'checkout_redirect') {
      if (isMenuGreeting(text)) {
        return this.buildWelcomeMessage(input.businessName, input.businessProfile, input.salesContext);
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

  buildWelcomeMessage(
    businessName: string,
    profile?: BusinessProfileConfig,
    previousContext?: SalesContext
  ): ConversationFlowResult {
    const description =
      profile?.description?.trim() ||
      'Somos *fabricantes de joyas en oro 18K*. Diseñamos y elaboramos piezas con la calidad que nos caracteriza.';

    const address =
      profile?.address?.trim() ||
      [
        '📍 *Edificio La Ceiba*, Local 101 — Primer piso',
        'Calle 52 #47-28, Medellín, Antioquia',
      ].join('\n');

    const hours = profile?.businessHours?.trim();

    const cartNote =
      previousContext?.cartItems?.length ?
        `\n\n🛒 Tienes *${previousContext.cartItems.length}* producto(s) en tu pedido. Pulsa *Finalizar pedido* cuando quieras completar la compra.`
      : null;

    const body = [
      `¡Hola! Bienvenido a *${businessName}*.`,
      '',
      description,
      '',
      address,
      hours ? `🕐 ${hours}` : null,
      cartNote,
      '',
      '¿En qué te podemos ayudar hoy?',
    ]
      .filter((line) => line !== null)
      .join('\n');

    const buttons =
      previousContext?.cartItems?.length ?
        [
          { id: WA_BTN.MENU_BUY, body: WA_BTN_LABEL.MENU_BUY },
          { id: WA_BTN.CART_FINALIZE, body: WA_BTN_LABEL.CART_FINALIZE },
          { id: WA_BTN.MENU_ORDERS, body: WA_BTN_LABEL.MENU_ORDERS },
        ]
      : [
          { id: WA_BTN.MENU_BUY, body: WA_BTN_LABEL.MENU_BUY },
          { id: WA_BTN.MENU_ORDERS, body: WA_BTN_LABEL.MENU_ORDERS },
          { id: WA_BTN.MENU_HELP, body: WA_BTN_LABEL.MENU_HELP },
        ];

    return {
      replyText: body,
      outbound: { kind: 'buttons', body, buttons },
      salesContext: {
        phase: 'browsing',
        flowStep: 'menu',
        cartItems: previousContext?.cartItems,
        customerName: previousContext?.customerName,
      },
    };
  }

  /** Tras agregar al carrito: acciones persistentes por botones. */
  buildCartActionPrompt(salesContext: SalesContext, introLine: string): ConversationFlowResult {
    const items = salesContext.cartItems ?? [];
    const summary = items.length ? CartService.formatSummary(items) : '';
    const body = [introLine, '', summary, '', '¿Qué deseas hacer?'].filter(Boolean).join('\n');

    return {
      replyText: body,
      outbound: {
        kind: 'buttons',
        body,
        buttons: [
          { id: WA_BTN.CART_ADD_MORE, body: WA_BTN_LABEL.CART_ADD_MORE },
          { id: WA_BTN.CART_FINALIZE, body: WA_BTN_LABEL.CART_FINALIZE },
          { id: WA_BTN.MENU_BACK, body: WA_BTN_LABEL.MENU_BACK },
        ],
      },
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
      'Completa tu pedido en el *formulario de la tienda* (recoger en tienda, envío a domicilio y método de pago):',
      checkoutUrl,
      '',
      'Usa el mismo número de WhatsApp (*' + customerPhone.replace(/\D/g, '') + '*) si el formulario lo pide.',
      'Cuando termines, recibirás confirmación por correo. Si necesitas ayuda, escríbeme por aquí.',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      replyText: body,
      outbound: { kind: 'text', body },
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
      return this.buildDiscoveryPrompt(
        input.salesContext,
        '¡Perfecto! Cuéntame qué joya buscas (cadena, anillo, balín, dije…) o describe lo que tienes en mente.'
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
        'Pulsa *Comprar* para empezar o escríbeme tu pregunta.',
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
      return this.buildWelcomeMessage(input.businessName, input.businessProfile, input.salesContext);
    }

    if (action === WA_BTN.CART_ADD_MORE) {
      return this.buildDiscoveryPrompt(
        input.salesContext,
        '¿Qué más te gustaría agregar? Cuéntame el producto o variante.'
      );
    }

    if (action === WA_BTN.CART_FINALIZE) {
      if (!input.salesContext.cartItems?.length) {
        return this.buildDiscoveryPrompt(
          input.salesContext,
          'Tu carrito está vacío. Cuéntame qué producto te interesa.'
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
