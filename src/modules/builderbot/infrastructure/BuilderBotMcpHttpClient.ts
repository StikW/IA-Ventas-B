import { env, hasBuilderBot } from '../../../shared/infrastructure/config/env';
import { DomainError } from '../../../shared/domain/errors/DomainError';
import { resolveBuilderBotApiUrl } from './builderBotApiMode';
import { isBuilderBotCloudProjectUuid } from './builderBotProjectId';

const BUILDERBOT_MCP_HTTP_URL = 'https://bbc-mcp-http.builderbot.cloud/mcp/builderbot/mcp';

type McpToolResponseEnvelope = {
  result?: {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  error?: { message?: string };
};

function parseMcpToolPayload(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return { success: true, message: String(parsed) };
  } catch {
    const lower = text.toLowerCase();
    if (lower.includes('error') || lower.includes('failed') || lower.includes('not found')) {
      throw new DomainError(text.trim(), 'BUILDERBOT_ERROR');
    }
    return { success: true, message: text.trim() };
  }
}

export async function callBuilderBotMcpTool<T extends Record<string, unknown>>(
  toolName: string,
  args: Record<string, unknown>
): Promise<T> {
  if (!hasBuilderBot) {
    throw new DomainError('BuilderBot no está configurado en el servidor', 'BUILDERBOT_NOT_CONFIGURED');
  }

  const response = await fetch(BUILDERBOT_MCP_HTTP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-builderbot-api-key': env.BUILDERBOT_API_KEY!.trim(),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new DomainError(`BuilderBot MCP error ${response.status}: ${body}`, 'BUILDERBOT_ERROR');
  }

  const envelope = (await response.json()) as McpToolResponseEnvelope;
  if (envelope.error?.message) {
    throw new DomainError(envelope.error.message, 'BUILDERBOT_ERROR');
  }

  const content = envelope.result?.content?.[0];
  if (!content?.text) {
    throw new DomainError('BuilderBot MCP devolvió respuesta vacía', 'BUILDERBOT_ERROR');
  }

  if (envelope.result?.isError || content.type === 'error') {
    throw new DomainError(content.text.trim(), 'BUILDERBOT_ERROR');
  }

  return parseMcpToolPayload(content.text) as T;
}

export async function listBuilderBotCloudProjects(): Promise<Array<{ uuid: string; name: string }>> {
  const raw = await callBuilderBotMcpTool<{ projects?: Array<{ uuid: string; name: string }> }>(
    'builderbot_list_projects',
    {}
  );
  return raw.projects ?? [];
}

export async function builderBotCloudProjectExists(projectId: string): Promise<boolean> {
  const projects = await listBuilderBotCloudProjects();
  return projects.some((p) => p.uuid === projectId);
}

/** Crea un proyecto en BuilderBot Cloud (instancia lógica del bot). */
export async function createBuilderBotCloudProject(name: string): Promise<{ projectId: string; name: string }> {
  const raw = await callBuilderBotMcpTool<Record<string, unknown>>('builderbot_create_project', {
    name,
    shareable: false,
  });

  const project = (raw.project ?? raw) as Record<string, unknown>;
  const projectId = String(project.uuid ?? project.id ?? '');
  if (!projectId) {
    throw new DomainError('BuilderBot no devolvió el ID del proyecto', 'BUILDERBOT_ERROR');
  }

  return { projectId, name: String(project.name ?? name) };
}

async function deleteBuilderBotCloudDeploy(projectId: string): Promise<void> {
  const base = resolveBuilderBotApiUrl('cloud-v2');
  try {
    const response = await fetch(`${base}/deploys/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      headers: { 'x-api-builderbot': env.BUILDERBOT_API_KEY!.trim() },
    });
    if (response.ok || response.status === 404) return;
  } catch {
    // fallback MCP
  }

  try {
    await callBuilderBotMcpTool('builderbot_deploy', { projectId, action: 'delete' });
  } catch {
    // deploy puede no existir
  }
}

/** Elimina deploy + proyecto completo en BuilderBot Cloud y verifica que ya no exista. */
export async function deleteBuilderBotCloudProject(projectId: string): Promise<void> {
  const id = projectId.trim();
  if (!id) return;

  if (!isBuilderBotCloudProjectUuid(id)) {
    throw new DomainError(
      `No se puede eliminar el proyecto BuilderBot: "${id}" no es un UUID válido`,
      'BUILDERBOT_ERROR'
    );
  }

  await deleteBuilderBotCloudDeploy(id);

  await callBuilderBotMcpTool('builderbot_delete_project', { projectId: id });

  const stillExists = await builderBotCloudProjectExists(id);
  if (stillExists) {
    throw new DomainError(
      'El proyecto sigue existiendo en BuilderBot Cloud después de solicitar su eliminación',
      'BUILDERBOT_ERROR'
    );
  }
}

export async function rebootBuilderBotCloudDeploy(projectId: string): Promise<void> {
  if (!isBuilderBotCloudProjectUuid(projectId)) return;
  try {
    await callBuilderBotMcpTool('builderbot_deploy', { projectId, action: 'reboot' });
  } catch {
    // opcional
  }
}
