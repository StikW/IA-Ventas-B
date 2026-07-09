import { BUILDERBOT_CLOUD_PANEL_URL } from './builderBotApiMode';

/** URL del panel BuilderBot Cloud para vincular WhatsApp (ventana emergente). */
export function buildBuilderBotConnectUrl(projectId: string): string {
  const base = BUILDERBOT_CLOUD_PANEL_URL.replace(/\/$/, '');
  return `${base}/project/${encodeURIComponent(projectId)}/deploy`;
}
