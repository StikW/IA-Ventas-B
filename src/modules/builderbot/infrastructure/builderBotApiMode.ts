import { env } from '../../../shared/infrastructure/config/env';

export type BuilderBotApiMode = 'wa-api' | 'cloud-v2';

export function resolveBuilderBotApiMode(): BuilderBotApiMode {
  const configured = env.BUILDERBOT_API_MODE;
  if (configured === 'wa-api' || configured === 'cloud-v2') return configured;

  const url = (env.BUILDERBOT_API_URL ?? '').toLowerCase();
  if (url.includes('app.builderbot.cloud')) return 'cloud-v2';
  return 'wa-api';
}

export function resolveBuilderBotApiUrl(mode: BuilderBotApiMode): string {
  if (env.BUILDERBOT_API_URL) {
    return env.BUILDERBOT_API_URL.replace(/\/$/, '');
  }
  return mode === 'cloud-v2'
    ? 'https://app.builderbot.cloud/api/v2'
    : 'https://wa-api.builderbot.app/v1';
}

export const BUILDERBOT_CLOUD_PANEL_URL = 'https://app.builderbot.cloud';
