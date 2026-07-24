import { inject, injectable } from 'tsyringe';
import { BuilderBotButtonOption } from '../../../builderbot/domain/IBuilderBotCloudService';
import { IConfigRepository } from '../../../tenant/domain/repositories/IConfigRepository';
import { SalesContext } from '../../domain/IChatSessionRepository';
import {
  isMenuGreeting,
  resolveButtonAction,
  WA_BTN,
  WA_BTN_LABEL,
} from '../../domain/whatsappFlow.constants';
import { SalesAgentToolsHandler } from './SalesAgentToolsHandler';

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

  async tryHandle(input: ConversationFlowInput): Promise<ConversationFlowResult | null> {
    const text = input.text.trim();
    if (!text) return null;

    const action = resolveButtonAction(text);
    const massiEnabled = await this.tools.massiBotEnabled(input.tenantId);

    if (action === WA_BTN.MENU_BUY) {
      return this.promptBuying(input.businessName);
    }

    if (action === WA_BTN.MENU_ORDERS) {
      return this.showOrders(input, massiEnabled);
    }

    if (action === WA_BTN.MENU_HELP) {
      return this.promptHelp(input.businessName);
    }

    if (action === WA_BTN.MENU_BACK || isMenuGreeting(text)) {
      if (input.salesContext.phase === 'awaiting_payment') {
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
      return this.buildMainMenu(input.businessName, input.salesContext);
    }

    if (input.salesContext.flowStep === 'payment_select' && action) {
      if (!massiEnabled || !input.salesContext.cartItems?.length) {
        return this.buildMainMenu(input.businessName, { ...input.salesContext, flowStep: 'menu' });
      }
      return this.handlePaymentSelection(input, action);
    }

    if (isMenuGreeting(text)) {
      return this.buildMainMenu(input.businessName, input.salesContext);
    }

    return null;
  }

  buildMainMenu(businessName: string, salesContext: SalesContext): ConversationFlowResult {
    const body = `¡Hola! Bienvenido a *${businessName}*.\n\n¿En qué te podemos ayudar hoy?`;
    return {
      replyText: body,
      outbound: {
        kind: 'buttons',
        body,
        footer: 'MASSI Joyería',
        buttons: [
          { id: WA_BTN.MENU_BUY, body: WA_BTN_LABEL.MENU_BUY },
          { id: WA_BTN.MENU_ORDERS, body: WA_BTN_LABEL.MENU_ORDERS },
          { id: WA_BTN.MENU_HELP, body: WA_BTN_LABEL.MENU_HELP },
        ],
      },
      salesContext: { ...salesContext, phase: salesContext.phase ?? 'browsing', flowStep: 'menu' },
    };
  }

  buildPaymentMethodPrompt(salesContext: SalesContext, totalHint?: string): ConversationFlowResult {
    const body = ['Perfecto. Elige cómo deseas pagar:', totalHint ? `\n${totalHint}` : ''].filter(Boolean).join('\n');

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

  private promptBuying(businessName: string): ConversationFlowResult {
    const body = `Genial. Cuéntame qué producto buscas en *${businessName}* (por ejemplo: "balín diamantado" o "cadena oro 18k").`;
    return {
      replyText: body,
      outbound: { kind: 'text', body },
      salesContext: { phase: 'browsing', flowStep: 'buying' },
    };
  }

  private promptHelp(businessName: string): ConversationFlowResult {
    const body = `Estoy aquí para ayudarte con *${businessName}*. Pregúntame lo que necesites: productos, horarios, pagos o estado de pedido.`;
    return {
      replyText: body,
      outbound: { kind: 'text', body },
      salesContext: { phase: 'browsing', flowStep: 'help' },
    };
  }

  private async showOrders(input: ConversationFlowInput, massiEnabled: boolean): Promise<ConversationFlowResult> {
    let ordersText = 'Consulta de pedidos no disponible en este momento.';
    if (massiEnabled) {
      ordersText = await this.tools.listMassiOrders(input.tenantId, input.customerPhone);
    }

    const body = `*Tus pedidos recientes:*\n${ordersText}\n\n¿Deseas hacer algo más?`;
    const menuButtons: BuilderBotButtonOption[] = [
      { id: WA_BTN.MENU_BUY, body: WA_BTN_LABEL.MENU_BUY },
      { id: WA_BTN.MENU_ORDERS, body: WA_BTN_LABEL.MENU_ORDERS },
      { id: WA_BTN.MENU_HELP, body: WA_BTN_LABEL.MENU_HELP },
    ];

    return {
      replyText: body,
      outbound: {
        kind: 'buttons',
        body,
        footer: 'MASSI Joyería',
        buttons: menuButtons,
      },
      salesContext: { ...input.salesContext, phase: input.salesContext.phase ?? 'browsing', flowStep: 'menu' },
    };
  }

  private async handlePaymentSelection(
    input: ConversationFlowInput,
    action: string
  ): Promise<ConversationFlowResult> {
    const items = input.salesContext.cartItems ?? [];
    const customerName = input.salesContext.customerName ?? input.customerPhone;

    if (action === WA_BTN.MENU_BACK) {
      return this.buildMainMenu(input.businessName, {
        ...input.salesContext,
        flowStep: 'menu',
        cartItems: undefined,
      });
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
      return {
        replyText: massiOrder.message,
        outbound: { kind: 'text', body: massiOrder.message },
        salesContext: { phase: 'browsing', flowStep: 'menu' },
      };
    }

    const tenantConfig = await this.configRepo.findByTenantId(input.tenantId);
    const bankInfo = tenantConfig?.business?.bankAccountInfo ?? 'Consulta al negocio los datos de pago.';

    if (paymentMethod === 'mdp_789') {
      const body = [
        `Pedido *#${massiOrder.order.orderNumber}* registrado.`,
        massiOrder.order.ticketCode ? `Ticket provisional: *${massiOrder.order.ticketCode}*.` : '',
        'Acércate a la joyería para completar el pago en efectivo y finalizar tu compra.',
        'Escribe *menú* cuando quieras volver al inicio.',
      ]
        .filter(Boolean)
        .join('\n');

      return {
        replyText: body,
        outbound: { kind: 'text', body },
        salesContext: {
          phase: 'order_created',
          flowStep: 'menu',
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
