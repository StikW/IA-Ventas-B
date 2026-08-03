import { inject, injectable } from 'tsyringe';
import { DomainError } from '../../../shared/domain/errors/DomainError';
import { env } from '../../../shared/infrastructure/config/env';
import { callBuilderBotMcpTool, rebootBuilderBotCloudDeploy } from './BuilderBotMcpHttpClient';
import { BuilderBotCloudUiFlowsRelay, BuilderBotUiFlowIds } from './BuilderBotCloudUiFlowsRelay';

const RELAY_FLOW_LABEL = 'ia_ventas_webhook_relay';
const RELAY_FLOW_NAME = 'IA Ventas — Agente';
const RELAY_FLOW_KEYWORDS = ['EVENTS.WELCOME'];

const ORDER_FLOW_LABEL = 'ia_ventas_order_relay';
const ORDER_FLOW_NAME = 'IA Ventas — Orden';
const ORDER_FLOW_KEYWORDS = ['EVENTS.ORDER'];

type FlowRecord = { id?: string; label?: string; name?: string; keywords?: string[] };
type AnswerRecord = {
  id?: string;
  type?: string;
  plugins?: { http?: { url?: string } | null };
};

type HttpRule = {
  conditionRule: string;
  conditionValue: string;
  conditionFlowId: string;
  condition: string;
};

type HttpPlugin = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, string>;
  rules: HttpRule[];
  messageMapping: string;
  avoidResponse: boolean;
};

@injectable()
export class BuilderBotCloudWebhookRelay {
  constructor(
    @inject(BuilderBotCloudUiFlowsRelay) private readonly uiFlowsRelay: BuilderBotCloudUiFlowsRelay
  ) {}

  async sync(projectId: string, webhookUrl: string): Promise<void> {
    const uiFlows = await this.uiFlowsRelay.sync(projectId);
    const flowId = await this.ensureRelayFlow(projectId);
    await this.ensureHttpAnswer(projectId, flowId, webhookUrl, uiFlows);

    const orderFlowId = await this.ensureOrderFlow(projectId);
    const orderWebhookUrl = `${webhookUrl.replace(/\/$/, '')}/order`;
    await this.ensureOrderHttpAnswer(projectId, orderFlowId, orderWebhookUrl, uiFlows);

    await rebootBuilderBotCloudDeploy(projectId);
  }

  private async ensureRelayFlow(projectId: string): Promise<string> {
    const listed = await callBuilderBotMcpTool<{ flows?: FlowRecord[] }>('builderbot_list_flows', { projectId });
    const existing = (listed.flows ?? []).find(
      (flow) =>
        flow.label === RELAY_FLOW_LABEL ||
        flow.name === RELAY_FLOW_NAME ||
        (flow.name?.includes('IA Ventas') && flow.keywords?.includes('EVENTS.WELCOME'))
    );
    if (existing?.id) return existing.id;

    const created = await callBuilderBotMcpTool<Record<string, unknown>>('builderbot_create_flow', {
      projectId,
      name: RELAY_FLOW_NAME,
      label: RELAY_FLOW_LABEL,
      keywords: RELAY_FLOW_KEYWORDS,
      listenKeywords: false,
      sort: 0,
    });

    const flow = (created.flow ?? created) as FlowRecord;
    const flowId = String(flow.id ?? created.id ?? '');
    if (!flowId) {
      throw new DomainError(
        'BuilderBot no devolvió el ID del flow para el webhook',
        'BUILDERBOT_WEBHOOK_SYNC_FAILED'
      );
    }

    return flowId;
  }

  /** Flow EVENTS.ORDER (catálogo nativo WhatsApp). Reutiliza el creado a mano si existe. */
  private async ensureOrderFlow(projectId: string): Promise<string> {
    const listed = await callBuilderBotMcpTool<{ flows?: FlowRecord[] }>('builderbot_list_flows', { projectId });
    const existing = (listed.flows ?? []).find((flow) => {
      const name = flow.name?.trim() ?? '';
      return (
        flow.label === ORDER_FLOW_LABEL ||
        name === ORDER_FLOW_NAME ||
        flow.keywords?.includes('EVENTS.ORDER') ||
        (name.includes('IA Ventas') && /orden/i.test(name))
      );
    });
    if (existing?.id) return existing.id;

    const created = await callBuilderBotMcpTool<Record<string, unknown>>('builderbot_create_flow', {
      projectId,
      name: ORDER_FLOW_NAME,
      label: ORDER_FLOW_LABEL,
      keywords: ORDER_FLOW_KEYWORDS,
      listenKeywords: false,
      sort: 1,
    });

    const flow = (created.flow ?? created) as FlowRecord;
    const flowId = String(flow.id ?? created.id ?? '');
    if (!flowId) {
      throw new DomainError(
        'BuilderBot no devolvió el ID del flow de pedido catálogo',
        'BUILDERBOT_WEBHOOK_SYNC_FAILED'
      );
    }

    return flowId;
  }

  private buildHttpHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const secret = env.BUILDERBOT_WEBHOOK_SECRET;
    if (secret) headers['x-webhook-secret'] = secret;
    return headers;
  }

  private buildRouteRules(uiFlows: BuilderBotUiFlowIds): HttpRule[] {
    return [
      { conditionRule: 'route', conditionValue: 'catalog', conditionFlowId: uiFlows.catalogFlowId },
      { conditionRule: 'route', conditionValue: 'cart', conditionFlowId: uiFlows.cartFlowId },
    ].map((rule) => ({ ...rule, condition: '===' }));
  }

  private buildHttpPlugin(webhookUrl: string, uiFlows: BuilderBotUiFlowIds): HttpPlugin {
    return {
      url: webhookUrl,
      method: 'POST',
      headers: this.buildHttpHeaders(),
      body: {
        event: 'message.incoming',
        from: '{from}',
        phone: '{from}',
        name: '{name}',
        text: '{body}',
      },
      rules: this.buildRouteRules(uiFlows),
      // BBC solo evalúa `rules` cuando procesa la respuesta: con `avoidResponse: true` nunca
      // salta al flow UI. El texto lo envía IA Ventas vía API v2, así que el mensaje mapeado
      // se deja vacío para que no llegue nada extra al cliente.
      messageMapping: '',
      avoidResponse: false,
    };
  }

  private buildOrderHttpPlugin(orderWebhookUrl: string, uiFlows: BuilderBotUiFlowIds): HttpPlugin {
    return {
      url: orderWebhookUrl,
      method: 'POST',
      headers: this.buildHttpHeaders(),
      body: {
        event: 'message.incoming',
        from: '{from}',
        phone: '{from}',
        name: '{name}',
        text: '{body}',
        order: '{orderData}',
      },
      rules: this.buildRouteRules(uiFlows),
      messageMapping: '',
      avoidResponse: false,
    };
  }

  private async ensureHttpAnswer(
    projectId: string,
    flowId: string,
    webhookUrl: string,
    uiFlows: BuilderBotUiFlowIds
  ): Promise<void> {
    await this.upsertHttpAnswer(projectId, flowId, webhookUrl, {
      http: this.buildHttpPlugin(webhookUrl, uiFlows),
    });
  }

  private async ensureOrderHttpAnswer(
    projectId: string,
    flowId: string,
    orderWebhookUrl: string,
    uiFlows: BuilderBotUiFlowIds
  ): Promise<void> {
    await this.upsertHttpAnswer(projectId, flowId, orderWebhookUrl, {
      http: this.buildOrderHttpPlugin(orderWebhookUrl, uiFlows),
    });
  }

  private async upsertHttpAnswer(
    projectId: string,
    flowId: string,
    targetUrl: string,
    plugins: { http: HttpPlugin }
  ): Promise<void> {
    const listed = await callBuilderBotMcpTool<{ answers?: AnswerRecord[] }>('builderbot_list_answers', {
      projectId,
      flowId,
    });

    const answers = listed.answers ?? [];
    const relayHttp = answers.find(
      (answer) => answer.type === 'add_http' && answer.plugins?.http?.url === targetUrl
    );
    const legacyHttp = answers.find((answer) => answer.type === 'add_http');
    const httpAnswer = relayHttp ?? legacyHttp;

    for (const answer of answers) {
      const isRelayHttp = answer.id && httpAnswer?.id && answer.id === httpAnswer.id;
      if (isRelayHttp) continue;
      if (!answer.id) continue;
      await callBuilderBotMcpTool('builderbot_delete_answer', {
        projectId,
        flowId,
        answerId: answer.id,
      });
    }

    if (httpAnswer?.id) {
      await callBuilderBotMcpTool('builderbot_update_answer', {
        projectId,
        flowId,
        answerId: httpAnswer.id,
        type: 'add_http',
        message: '',
        plugins,
      });
      return;
    }

    await callBuilderBotMcpTool('builderbot_create_answer', {
      projectId,
      flowId,
      type: 'add_http',
      message: '',
      sort: 0,
      plugins,
    });
  }
}
