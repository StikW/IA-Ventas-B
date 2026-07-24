import { inject, injectable } from 'tsyringe';
import { BuilderBotButtonOption } from '../../../builderbot/domain/IBuilderBotCloudService';
import { IConfigRepository } from '../../../tenant/domain/repositories/IConfigRepository';
import { SalesContext } from '../../domain/IChatSessionRepository';
import {
  isMenuGreeting,
  resolveButtonAction,
  resolvePaymentMethodChoice,
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

    if (
      isMenuGreeting(text) &&
      input.salesContext.flowStep !== 'payment_select' &&
      input.salesContext.phase !== 'awaiting_payment'
    ) {
      return this.buildWelcomeMessage(input.businessName, input.salesContext);
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

  buildWelcomeMessage(businessName: string, salesContext: SalesContext): ConversationFlowResult {
    const body = [
      `¡Hola! Bienvenido a *${businessName}*.`,
      '',
      '¿En qué te podemos ayudar hoy?',
      'Puedes preguntarme por productos, precios, pedidos o cómo comprar.',
    ].join('\n');

    return {
      replyText: body,
      outbound: { kind: 'text', body },
      salesContext: { phase: 'browsing' },
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

  private cancelPaymentSelection(message: string): ConversationFlowResult {
    return {
      replyText: message,
      outbound: { kind: 'text', body: message },
      salesContext: { phase: 'browsing' },
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
