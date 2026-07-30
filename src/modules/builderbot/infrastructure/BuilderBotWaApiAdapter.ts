import { injectable } from 'tsyringe';
import { env, hasBuilderBot } from '../../../shared/infrastructure/config/env';
import { DomainError } from '../../../shared/domain/errors/DomainError';
import {
  BuilderBotDevice,
  BuilderBotQrResponse,
  BuilderBotSessionStatus,
  CreateBuilderBotDeviceInput,
  IBuilderBotCloudService,
  SendTextMessageInput,
  SendButtonsMessageInput,
  SendCtaUrlMessageInput,
  SendListMessageInput,
} from '../domain/IBuilderBotCloudService';
import { renderCtaUrlAsText } from '../domain/interactiveFallback.utils';
import { resolveBuilderBotApiMode, resolveBuilderBotApiUrl } from './builderBotApiMode';

@injectable()
export class BuilderBotWaApiAdapter implements IBuilderBotCloudService {
  private baseUrl(): string {
    return resolveBuilderBotApiUrl(resolveBuilderBotApiMode());
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    if (!hasBuilderBot) {
      throw new DomainError('BuilderBot no está configurado en el servidor', 'BUILDERBOT_NOT_CONFIGURED');
    }

    const url = `${this.baseUrl()}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: env.BUILDERBOT_API_KEY!,
        ...(options?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new DomainError(`BuilderBot API error ${response.status}: ${body}`, 'BUILDERBOT_ERROR');
    }

    if (response.status === 204) return {} as T;
    const text = await response.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  private mapDevice(raw: Record<string, unknown>): BuilderBotDevice {
    const deviceId = String(raw.id ?? raw.device ?? raw.deviceId ?? '');
    const statusRaw = String(raw.status ?? raw.sessionStatus ?? raw.state ?? 'unknown').toLowerCase();
    let status: BuilderBotSessionStatus = 'unknown';
    if (statusRaw.includes('connect') && !statusRaw.includes('disconnect')) status = 'connected';
    else if (statusRaw.includes('qr') || statusRaw.includes('pair')) status = 'connecting';
    else if (statusRaw.includes('disconnect') || statusRaw === 'offline') status = 'disconnected';

    return {
      deviceId,
      name: raw.name ? String(raw.name) : undefined,
      phone: raw.phone ? String(raw.phone) : raw.number ? String(raw.number) : undefined,
      status,
    };
  }

  async createDevice(input: CreateBuilderBotDeviceInput): Promise<BuilderBotDevice> {
    const name = input.name ?? input.projectId;
    const raw = await this.request<Record<string, unknown>>('/devices', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    const data = (raw.data as Record<string, unknown>) ?? raw;
    return this.mapDevice(data);
  }

  async getDevice(deviceId: string): Promise<BuilderBotDevice> {
    const raw = await this.request<Record<string, unknown>>(`/devices/${deviceId}`);
    const data = (raw.data as Record<string, unknown>) ?? raw;
    return this.mapDevice(data);
  }

  async getSessionStatus(deviceId: string): Promise<BuilderBotSessionStatus> {
    try {
      const raw = await this.request<Record<string, unknown>>(`/devices/${deviceId}/status`);
      const data = (raw.data as Record<string, unknown>) ?? raw;
      return this.mapDevice(data).status ?? 'unknown';
    } catch {
      const device = await this.getDevice(deviceId);
      return device.status ?? 'unknown';
    }
  }

  async getQrCode(deviceId: string): Promise<BuilderBotQrResponse> {
    const raw = await this.request<Record<string, unknown>>(`/devices/${deviceId}/qr`);
    const data = (raw.data as Record<string, unknown>) ?? raw;
    return {
      qrImageUrl: data.qr ? String(data.qr) : data.url ? String(data.url) : data.image ? String(data.image) : undefined,
      qrBase64: data.base64 ? String(data.base64) : undefined,
      pairingCode: data.code ? String(data.code) : data.pairingCode ? String(data.pairingCode) : undefined,
    };
  }

  async requestPairingCode(deviceId: string, phone: string): Promise<{ pairingCode?: string }> {
    const raw = await this.request<Record<string, unknown>>(`/devices/${deviceId}/connect`, {
      method: 'POST',
      body: JSON.stringify({ phone }),
    });
    const data = (raw.data as Record<string, unknown>) ?? raw;
    return {
      pairingCode: data.code ? String(data.code) : data.pairingCode ? String(data.pairingCode) : undefined,
    };
  }

  async updateDevice(deviceId: string, payload: Record<string, unknown>): Promise<void> {
    await this.request(`/devices/${deviceId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }

  async sendTextMessage(input: SendTextMessageInput): Promise<void> {
    await this.request('/messages', {
      method: 'POST',
      body: JSON.stringify({
        device: input.deviceId,
        phone: input.phone,
        message: input.message.trim(),
      }),
    });
  }

  supportsInteractiveMessages(): boolean {
    return true;
  }

  async sendButtonsMessage(input: SendButtonsMessageInput): Promise<void> {
    const buttons = input.buttons.slice(0, 3).map((btn) => ({
      body: btn.body,
      id: btn.id ?? btn.body,
    }));

    await this.request('/messages', {
      method: 'POST',
      body: JSON.stringify({
        device: input.deviceId,
        phone: input.phone,
        message: input.body.trim(),
        footer: input.footer?.trim(),
        buttons,
      }),
    });
  }

  async sendCtaUrlMessage(input: SendCtaUrlMessageInput): Promise<void> {
    await this.sendTextMessage({
      deviceId: input.deviceId,
      phone: input.phone,
      message: renderCtaUrlAsText(input),
    });
  }

  async sendListMessage(input: SendListMessageInput): Promise<void> {
    const sections = input.sections.map((section) => ({
      title: section.title,
      rows: section.rows.slice(0, 10),
    }));

    try {
      await this.request('/messages', {
        method: 'POST',
        body: JSON.stringify({
          device: input.deviceId,
          phone: input.phone,
          message: input.body.trim(),
          footer: input.footer?.trim(),
          list: {
            title: input.title?.trim(),
            buttonText: input.buttonText.trim(),
            sections,
          },
        }),
      });
    } catch {
      const lines = sections.flatMap((s) =>
        s.rows.map((r) => `- ${r.title}${r.description ? `: ${r.description}` : ''}`)
      );
      const fallback = [input.body.trim(), ...lines].join('\n');
      await this.sendTextMessage({ deviceId: input.deviceId, phone: input.phone, message: fallback });
    }
  }

  async deleteDevice(deviceId: string): Promise<void> {
    await this.request(`/devices/${deviceId}`, { method: 'DELETE' });
  }

  async deleteProject(_projectId: string): Promise<void> {
    // wa-api no tiene concepto de proyecto BBC; deleteDevice es suficiente
  }

  async ensureDeployReady(deviceId: string): Promise<BuilderBotSessionStatus> {
    return this.getSessionStatus(deviceId);
  }

  async getQrImageBuffer(deviceId: string): Promise<Buffer> {
    const qr = await this.getQrCode(deviceId);
    if (qr.qrBase64) return Buffer.from(qr.qrBase64, 'base64');
    if (qr.qrImageUrl?.startsWith('data:image')) {
      const base64 = qr.qrImageUrl.split(',')[1] ?? '';
      if (base64) return Buffer.from(base64, 'base64');
    }
    throw new DomainError('BuilderBot no devolvió un QR válido', 'BUILDERBOT_QR_EMPTY');
  }
}
