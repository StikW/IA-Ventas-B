import { BuilderBotConfigData } from './IBuilderBotCloudService';

/** Por defecto activo (compatibilidad con configs existentes sin el campo). */
export function isSalesAgentEnabled(
  config: Pick<BuilderBotConfigData, 'agentEnabled'> | null | undefined
): boolean {
  return config?.agentEnabled !== false;
}
