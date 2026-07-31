import { injectable } from 'tsyringe';
import { DomainError } from '../../../shared/domain/errors/DomainError';
import { callBuilderBotMcpTool } from './BuilderBotMcpHttpClient';

interface UiFlowSpec {
  key: keyof BuilderBotUiFlowIds;
  label: string;
  name: string;
  keyword: string;
  message: string;
  sort: number;
  /** Encadena otro flow UI tras este mensaje (WhatsApp no admite Reply y CTA URL juntos). */
  gotoFlow?: keyof BuilderBotUiFlowIds;
}

/**
 * Flows que solo existen para mostrar botones: el MCP crea el flow y su texto, pero los
 * botones (Reply / CTA URL) se agregan a mano en el panel BBC porque el esquema del MCP
 * no los acepta.
 */
const UI_FLOWS: UiFlowSpec[] = [
  {
    key: 'catalogFlowId',
    label: 'ia_ventas_ui_catalog',
    name: 'IA Ventas — Catalogo',
    keyword: '__ia_ventas_route_catalog__',
    message: 'Link de nuestro Catálogo Oficial',
    sort: 10,
  },
  {
    key: 'cartFlowId',
    label: 'ia_ventas_ui_cart',
    name: 'IA Ventas — Vaciar Carrito',
    keyword: '__ia_ventas_route_cart__',
    message: [
      '🛒 *¿Qué deseas hacer con tu carrito?*',
      '',
      'Si deseas *eliminar todo tu carrito y empezar de nuevo*, presiona el botón *Vaciar carrito*.',
      '',
      'Si prefieres *modificar tu carrito*, escríbeme con tus propias palabras qué deseas hacer: agregar un producto, eliminar uno, cambiar la cantidad o reemplazarlo por otro.',
      '',
      'Si no recuerdas el *ID del producto*, a continuación te comparto el catálogo.',
    ].join('\n'),
    sort: 11,
    gotoFlow: 'catalogFlowId',
  },
];

export interface BuilderBotUiFlowIds {
  catalogFlowId: string;
  cartFlowId: string;
}

type FlowRecord = { id?: string; label?: string; name?: string; keywords?: string[] };
type AnswerRecord = { id?: string; type?: string; message?: string };

@injectable()
export class BuilderBotCloudUiFlowsRelay {
  async sync(projectId: string): Promise<BuilderBotUiFlowIds> {
    const ids = {} as BuilderBotUiFlowIds;

    // Los flows se crean antes que los answers para poder encadenarlos con gotoFlow.
    for (const spec of UI_FLOWS) {
      ids[spec.key] = await this.ensureFlow(projectId, spec);
    }

    for (const spec of UI_FLOWS) {
      await this.ensureTextAnswer(
        projectId,
        ids[spec.key],
        spec.message,
        spec.gotoFlow ? ids[spec.gotoFlow] : undefined
      );
    }

    return ids;
  }

  private async ensureFlow(projectId: string, spec: UiFlowSpec): Promise<string> {
    const listed = await callBuilderBotMcpTool<{ flows?: FlowRecord[] }>('builderbot_list_flows', { projectId });
    const existing = (listed.flows ?? []).find(
      (flow) => flow.label === spec.label || flow.name === spec.name || flow.keywords?.includes(spec.keyword)
    );
    if (existing?.id) return existing.id;

    const created = await callBuilderBotMcpTool<Record<string, unknown>>('builderbot_create_flow', {
      projectId,
      name: spec.name,
      label: spec.label,
      keywords: [spec.keyword],
      listenKeywords: false,
      sort: spec.sort,
    });

    const flow = (created.flow ?? created) as FlowRecord;
    const flowId = String(flow.id ?? created.id ?? '');
    if (!flowId) {
      throw new DomainError(
        `BuilderBot no devolvió el ID del flow UI "${spec.name}"`,
        'BUILDERBOT_WEBHOOK_SYNC_FAILED'
      );
    }

    return flowId;
  }

  /**
   * Nunca reescribe un answer existente: el MCP no envía los botones configurados en el
   * panel y actualizarlo los perdería. Cambiar el copy de un flow ya creado es manual.
   */
  private async ensureTextAnswer(
    projectId: string,
    flowId: string,
    message: string,
    gotoFlowId?: string
  ): Promise<void> {
    const listed = await callBuilderBotMcpTool<{ answers?: AnswerRecord[] }>('builderbot_list_answers', {
      projectId,
      flowId,
    });

    const answers = listed.answers ?? [];
    if (answers.some((answer) => answer.type === 'add_text')) return;

    await callBuilderBotMcpTool('builderbot_create_answer', {
      projectId,
      flowId,
      type: 'add_text',
      message,
      sort: 0,
      ...(gotoFlowId ? { options: { gotoFlow: gotoFlowId } } : {}),
    });
  }
}
