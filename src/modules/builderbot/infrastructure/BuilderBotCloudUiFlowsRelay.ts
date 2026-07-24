import { injectable } from 'tsyringe';
import { DomainError } from '../../../shared/domain/errors/DomainError';
import { callBuilderBotMcpTool } from './BuilderBotMcpHttpClient';

const UI_MENU_FLOW_LABEL = 'ia_ventas_ui_menu';
const UI_MENU_FLOW_NAME = 'IA Ventas — Menú UI';
const UI_PAYMENT_FLOW_LABEL = 'ia_ventas_ui_payment';
const UI_PAYMENT_FLOW_NAME = 'IA Ventas — Pago UI';

/** Keywords internos: solo se alcanzan vía reglas HTTP (route=menu|payment), no por el usuario. */
const UI_ROUTE_KEYWORDS = {
  menu: '__ia_ventas_route_menu__',
  payment: '__ia_ventas_route_payment__',
} as const;

export interface BuilderBotUiFlowIds {
  menuFlowId: string;
  paymentFlowId: string;
}

type FlowRecord = { id?: string; label?: string; name?: string; keywords?: string[] };
type AnswerRecord = { id?: string; type?: string; message?: string };

@injectable()
export class BuilderBotCloudUiFlowsRelay {
  async sync(projectId: string): Promise<BuilderBotUiFlowIds> {
    const menuFlowId = await this.ensureUiFlow(projectId, {
      label: UI_MENU_FLOW_LABEL,
      name: UI_MENU_FLOW_NAME,
      keyword: UI_ROUTE_KEYWORDS.menu,
      message: '¿En qué te podemos ayudar hoy?',
      sort: 10,
    });

    const paymentFlowId = await this.ensureUiFlow(projectId, {
      label: UI_PAYMENT_FLOW_LABEL,
      name: UI_PAYMENT_FLOW_NAME,
      keyword: UI_ROUTE_KEYWORDS.payment,
      message: 'Perfecto. Elige cómo deseas pagar:',
      sort: 11,
    });

    return { menuFlowId, paymentFlowId };
  }

  private async ensureUiFlow(
    projectId: string,
    input: { label: string; name: string; keyword: string; message: string; sort: number }
  ): Promise<string> {
    const flowId = await this.ensureFlow(projectId, input);
    await this.ensureTextAnswer(projectId, flowId, input.message);
    return flowId;
  }

  private async ensureFlow(
    projectId: string,
    input: { label: string; name: string; keyword: string; sort: number }
  ): Promise<string> {
    const listed = await callBuilderBotMcpTool<{ flows?: FlowRecord[] }>('builderbot_list_flows', { projectId });
    const existing = (listed.flows ?? []).find(
      (flow) => flow.label === input.label || flow.name === input.name
    );
    if (existing?.id) return existing.id;

    const created = await callBuilderBotMcpTool<Record<string, unknown>>('builderbot_create_flow', {
      projectId,
      name: input.name,
      label: input.label,
      keywords: [input.keyword],
      listenKeywords: false,
      sort: input.sort,
    });

    const flow = (created.flow ?? created) as FlowRecord;
    const flowId = String(flow.id ?? created.id ?? '');
    if (!flowId) {
      throw new DomainError('BuilderBot no devolvió el ID del flow UI', 'BUILDERBOT_WEBHOOK_SYNC_FAILED');
    }

    return flowId;
  }

  private async ensureTextAnswer(projectId: string, flowId: string, message: string): Promise<void> {
    const listed = await callBuilderBotMcpTool<{ answers?: AnswerRecord[] }>('builderbot_list_answers', {
      projectId,
      flowId,
    });

    const answers = listed.answers ?? [];
    const textAnswer = answers.find((answer) => answer.type === 'add_text');

    if (textAnswer?.id) {
      if (textAnswer.message === message) return;
      await callBuilderBotMcpTool('builderbot_update_answer', {
        projectId,
        flowId,
        answerId: textAnswer.id,
        type: 'add_text',
        message,
      });
      return;
    }

    await callBuilderBotMcpTool('builderbot_create_answer', {
      projectId,
      flowId,
      type: 'add_text',
      message,
      sort: 0,
    });
  }
}
