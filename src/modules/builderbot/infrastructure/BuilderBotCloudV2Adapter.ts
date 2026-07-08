import { injectable } from 'tsyringe';
import { env, hasBuilderBot } from '../../../shared/infrastructure/config/env';
import { DomainError } from '../../../shared/domain/errors/DomainError';
import {
  BuilderBotDevice,
  BuilderBotQrResponse,
  BuilderBotSessionStatus,
  IBuilderBotCloudService,
  SendTextMessageInput,
} from '../domain/IBuilderBotCloudService';
import { BUILDERBOT_CLOUD_PANEL_URL, resolveBuilderBotApiUrl } from './builderBotApiMode';

type JsonRecord = Record<string, unknown>;

@injectable()
export class BuilderBotCloudV2Adapter implements IBuilderBotCloudService {
  private baseUrl(): string {
    return resolveBuilderBotApiUrl('cloud-v2');
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    const key = env.BUILDERBOT_API_KEY!.trim();
    return {
      'Content-Type': 'application/json',
      'x-api-builderbot': key,
      Authorization: `Bearer ${key}`,
      ...(extra ?? {}),
    };
  }

  private unwrap(raw: JsonRecord): JsonRecord {
    if (raw.data && typeof raw.data === 'object') return raw.data as JsonRecord;
    if (raw.bot && typeof raw.bot === 'object') return raw.bot as JsonRecord;
    return raw;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    if (!hasBuilderBot) {
      throw new DomainError('BuilderBot no está configurado en el servidor', 'BUILDERBOT_NOT_CONFIGURED');
    }

    const url = `${this.baseUrl()}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.authHeaders(),
        ...(options?.headers as Record<string, string> | undefined),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new DomainError(`BuilderBot Cloud API error ${response.status}: ${body}`, 'BUILDERBOT_ERROR');
    }

    if (response.status === 204) return {} as T;
    const text = await response.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  private async requestFirstOk<T>(paths: Array<{ path: string; init?: RequestInit }>): Promise<T> {
    let lastError: DomainError | null = null;
    for (const candidate of paths) {
      try {
        return await this.request<T>(candidate.path, candidate.init);
      } catch (error) {
        if (error instanceof DomainError && (error.message.includes('404') || error.message.includes('405'))) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new DomainError('BuilderBot Cloud API: ningún endpoint respondió', 'BUILDERBOT_ERROR');
  }

  private mapBot(raw: JsonRecord): BuilderBotDevice {
    const deviceId = String(raw.id ?? raw.botId ?? raw.uuid ?? '');
    const whatsapp = (raw.whatsapp as JsonRecord | undefined) ?? (raw.channel as JsonRecord | undefined);
    const statusRaw = String(
      raw.status ?? raw.sessionStatus ?? raw.state ?? whatsapp?.status ?? whatsapp?.state ?? 'unknown'
    ).toLowerCase();

    let status: BuilderBotSessionStatus = 'unknown';
    if (statusRaw.includes('connect') && !statusRaw.includes('disconnect')) status = 'connected';
    else if (statusRaw.includes('qr') || statusRaw.includes('pair') || statusRaw.includes('pending')) {
      status = 'connecting';
    } else if (statusRaw.includes('disconnect') || statusRaw === 'offline') status = 'disconnected';

    return {
      deviceId,
      name: raw.name ? String(raw.name) : undefined,
      phone: raw.phone
        ? String(raw.phone)
        : raw.number
          ? String(raw.number)
          : whatsapp?.phone
            ? String(whatsapp.phone)
            : undefined,
      status,
    };
  }

  async createDevice(name: string): Promise<BuilderBotDevice> {
    const raw = await this.requestFirstOk<JsonRecord>([
      { path: '/bots', init: { method: 'POST', body: JSON.stringify({ name }) } },
      { path: '/bot', init: { method: 'POST', body: JSON.stringify({ name }) } },
      { path: '', init: { method: 'POST', body: JSON.stringify({ name }) } },
    ]);
    return this.mapBot(this.unwrap(raw));
  }

  async getDevice(deviceId: string): Promise<BuilderBotDevice> {
    const raw = await this.requestFirstOk<JsonRecord>([
      { path: `/${deviceId}` },
      { path: `/bots/${deviceId}` },
      { path: `/bot/${deviceId}` },
    ]);
    return this.mapBot(this.unwrap(raw));
  }

  async getSessionStatus(deviceId: string): Promise<BuilderBotSessionStatus> {
    try {
      const raw = await this.requestFirstOk<JsonRecord>([
        { path: `/${deviceId}/whatsapp/status` },
        { path: `/${deviceId}/status` },
        { path: `/bots/${deviceId}/status` },
      ]);
      return this.mapBot(this.unwrap(raw)).status ?? 'unknown';
    } catch {
      const device = await this.getDevice(deviceId);
      return device.status ?? 'unknown';
    }
  }

  async getQrCode(_deviceId: string): Promise<BuilderBotQrResponse> {
    throw new DomainError(
      `En BuilderBot Cloud la conexión WhatsApp se hace desde el panel (${BUILDERBOT_CLOUD_PANEL_URL}). Abre tu bot y vincula el número allí.`,
      'BUILDERBOT_CLOUD_CONNECT_IN_PANEL'
    );
  }

  async requestPairingCode(_deviceId: string, _phone: string): Promise<{ pairingCode?: string }> {
    throw new DomainError(
      `En BuilderBot Cloud el emparejamiento se hace desde el panel (${BUILDERBOT_CLOUD_PANEL_URL}).`,
      'BUILDERBOT_CLOUD_CONNECT_IN_PANEL'
    );
  }

  async updateDevice(deviceId: string, payload: Record<string, unknown>): Promise<void> {
    const body = {
      ...payload,
      webhook: payload.webhook ?? payload.webhookUrl,
      webhookUrl: payload.webhookUrl ?? payload.webhook,
    };
    await this.requestFirstOk([
      { path: `/${deviceId}`, init: { method: 'PATCH', body: JSON.stringify(body) } },
      { path: `/bots/${deviceId}`, init: { method: 'PATCH', body: JSON.stringify(body) } },
      { path: `/${deviceId}/webhook`, init: { method: 'POST', body: JSON.stringify(body) } },
      { path: `/bots/${deviceId}/webhook`, init: { method: 'POST', body: JSON.stringify(body) } },
    ]);
  }

  async sendTextMessage(input: SendTextMessageInput): Promise<void> {
    const payload = {
      phone: input.phone,
      to: input.phone,
      number: input.phone,
      message: input.message.trim(),
      text: input.message.trim(),
      botId: input.deviceId,
    };
    await this.requestFirstOk([
      {
        path: `/${input.deviceId}/messages`,
        init: { method: 'POST', body: JSON.stringify(payload) },
      },
      {
        path: `/bots/${input.deviceId}/messages`,
        init: { method: 'POST', body: JSON.stringify(payload) },
      },
      {
        path: '/messages',
        init: { method: 'POST', body: JSON.stringify({ ...payload, device: input.deviceId }) },
      },
    ]);
  }

  async deleteDevice(deviceId: string): Promise<void> {
    await this.requestFirstOk([
      { path: `/${deviceId}`, init: { method: 'DELETE' } },
      { path: `/bots/${deviceId}`, init: { method: 'DELETE' } },
    ]);
  }
}
