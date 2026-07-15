import { injectable } from 'tsyringe';
import { DomainError } from '../../../shared/domain/errors/DomainError';
import { env } from '../../../shared/infrastructure/config/env';
import { callBuilderBotMcpTool, rebootBuilderBotCloudDeploy } from './BuilderBotMcpHttpClient';

const RELAY_FLOW_LABEL = 'ia_ventas_webhook_relay';
const RELAY_FLOW_NAME = 'IA Ventas — Agente';
const RELAY_FLOW_KEYWORDS = ['EVENTS.WELCOME'];

type FlowRecord = { id?: string; label?: string; name?: string; keywords?: string[] };
type AnswerRecord = { id?: string; type?: string };

@injectable()
export class BuilderBotCloudWebhookRelay {
  async sync(projectId: string, webhookUrl: string): Promise<void> {
    const flowId = await this.ensureRelayFlow(projectId);
    await this.ensureHttpAnswer(projectId, flowId, webhookUrl);
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

  private buildHttpPlugin(webhookUrl: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const secret = env.BUILDERBOT_WEBHOOK_SECRET;
    if (secret) headers['x-webhook-secret'] = secret;

    return {
      url: webhookUrl,
      method: 'POST',
      headers,
      body: {
        event: 'message.incoming',
        from: '{{ctx.from}}',
        phone: '{{ctx.from}}',
        text: '{{ctx.body}}',
        name: '{{ctx.name}}',
      },
      rules: [],
      avoidResponse: true,
    };
  }

  private async ensureHttpAnswer(projectId: string, flowId: string, webhookUrl: string): Promise<void> {
    const listed = await callBuilderBotMcpTool<{ answers?: AnswerRecord[] }>('builderbot_list_answers', {
      projectId,
      flowId,
    });

    const plugins = { http: this.buildHttpPlugin(webhookUrl) };
    const httpAnswer = (listed.answers ?? []).find((answer) => answer.type === 'add_http');

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
