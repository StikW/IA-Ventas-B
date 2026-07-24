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
  SendListMessageInput,
} from '../domain/IBuilderBotCloudService';

import { resolveBuilderBotApiUrl, resolveBuilderBotCloudMessagesUrl } from './builderBotApiMode';
import { deleteBuilderBotCloudProject, rebootBuilderBotCloudDeploy } from './BuilderBotMcpHttpClient';



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

      ...(extra ?? {}),

    };

  }



  private unwrap(raw: JsonRecord): JsonRecord {

    if (raw.data && typeof raw.data === 'object') return raw.data as JsonRecord;

    if (raw.deploy && typeof raw.deploy === 'object') return raw.deploy as JsonRecord;

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



  private mapStatus(raw: JsonRecord): BuilderBotSessionStatus {

    const statusRaw = String(

      raw.status ?? raw.sessionStatus ?? raw.state ?? raw.connectionStatus ?? 'unknown'

    ).toLowerCase();



    if (

      statusRaw.includes('online') ||

      statusRaw.includes('connected') ||

      (statusRaw.includes('connect') && !statusRaw.includes('disconnect'))

    ) {

      return 'connected';

    }

    if (

      statusRaw.includes('ready_to_scan') ||

      statusRaw.includes('ready-to-scan') ||

      statusRaw.includes('qr') ||

      statusRaw.includes('pair') ||

      statusRaw.includes('pending') ||

      statusRaw.includes('initialization') ||

      statusRaw.includes('initial')

    ) {

      return 'connecting';

    }

    if (statusRaw.includes('failed') || statusRaw.includes('disconnect') || statusRaw === 'offline') {

      return 'disconnected';

    }

    return 'unknown';

  }



  private mapDeploy(projectId: string, raw: JsonRecord, name?: string): BuilderBotDevice {

    const data = this.unwrap(raw);

    return {

      deviceId: String(data.projectId ?? data.id ?? projectId),

      name: data.name ? String(data.name) : name,

      phone: data.phone

        ? String(data.phone)

        : data.number

          ? String(data.number)

          : data.host

            ? String(data.host)

            : undefined,

      status: this.mapStatus(data),

    };

  }



  private mapQr(raw: JsonRecord): BuilderBotQrResponse {

    const data = this.unwrap(raw);

    const qrValue = data.qr ?? data.qrCode ?? data.qrcode ?? data.image ?? data.url ?? data.base64Qr;

    const qrString = qrValue != null ? String(qrValue) : undefined;



    let qrImageUrl: string | undefined;

    let qrBase64: string | undefined;



    if (qrString) {

      if (qrString.startsWith('data:image')) {

        qrImageUrl = qrString;

      } else if (qrString.startsWith('http')) {

        qrImageUrl = qrString;

      } else if (/^[A-Za-z0-9+/=]+$/.test(qrString) && qrString.length > 100) {

        qrBase64 = qrString;

      } else if (qrString.length > 0) {

        qrBase64 = qrString;

      }

    }



    if (data.base64) qrBase64 = String(data.base64);

    if (data.qrImageUrl) qrImageUrl = String(data.qrImageUrl);

    if (data.qrBase64) qrBase64 = String(data.qrBase64);



    return {

      qrImageUrl,

      qrBase64,

      pairingCode: data.code ? String(data.code) : data.pairingCode ? String(data.pairingCode) : undefined,

    };

  }



  async createDevice(input: CreateBuilderBotDeviceInput): Promise<BuilderBotDevice> {

    const projectId = input.projectId.trim();

    const raw = await this.request<JsonRecord>('/deploys', {

      method: 'POST',

      body: JSON.stringify({ projectId }),

    });

    const device = this.mapDeploy(projectId, raw, input.name);

    return { ...device, deviceId: projectId, status: device.status ?? 'connecting' };

  }



  async getDevice(deviceId: string): Promise<BuilderBotDevice> {

    try {

      const raw = await this.request<JsonRecord>(`/deploys/${encodeURIComponent(deviceId)}`);

      return this.mapDeploy(deviceId, raw);

    } catch {

      return { deviceId, status: 'unknown' };

    }

  }



  async getSessionStatus(deviceId: string): Promise<BuilderBotSessionStatus> {

    try {

      const device = await this.getDevice(deviceId);

      if (device.status && device.status !== 'unknown') return device.status;

    } catch {

      // intentar inferir desde QR

    }



    try {

      const qr = await this.getQrCode(deviceId);

      if (qr.qrImageUrl || qr.qrBase64) return 'connecting';

    } catch {

      // sin QR disponible

    }



    return 'unknown';

  }



  async getQrCode(deviceId: string): Promise<BuilderBotQrResponse> {

    if (!hasBuilderBot) {

      throw new DomainError('BuilderBot no está configurado en el servidor', 'BUILDERBOT_NOT_CONFIGURED');

    }



    const url = `${this.baseUrl()}/deploys/${encodeURIComponent(deviceId)}/qr`;

    const response = await fetch(url, { headers: this.authHeaders() });



    if (!response.ok) {

      const body = await response.text();

      throw new DomainError(`BuilderBot Cloud API error ${response.status}: ${body}`, 'BUILDERBOT_ERROR');

    }



    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('image/')) {

      const buffer = Buffer.from(await response.arrayBuffer());

      const mime = contentType.split(';')[0].trim() || 'image/png';

      const base64 = buffer.toString('base64');

      return { qrImageUrl: `data:${mime};base64,${base64}` };

    }



    const text = await response.text();

    if (!text) {

      throw new DomainError('BuilderBot no devolvió un QR válido', 'BUILDERBOT_QR_EMPTY');

    }



    let raw: JsonRecord;

    try {

      raw = JSON.parse(text) as JsonRecord;

    } catch {

      if (/^[A-Za-z0-9+/=]+$/.test(text) && text.length > 100) {

        return { qrBase64: text };

      }

      throw new DomainError('BuilderBot no devolvió un QR válido', 'BUILDERBOT_QR_EMPTY');

    }



    const qr = this.mapQr(raw);

    if (!qr.qrImageUrl && !qr.qrBase64 && !qr.pairingCode) {

      throw new DomainError('BuilderBot no devolvió un QR válido', 'BUILDERBOT_QR_EMPTY');

    }

    return qr;

  }



  private sleep(ms: number): Promise<void> {

    return new Promise((resolve) => setTimeout(resolve, ms));

  }



  async ensureDeployReady(deviceId: string): Promise<BuilderBotSessionStatus> {

    let status = await this.getSessionStatus(deviceId);

    if (status === 'connected') return status;



    let device = await this.getDevice(deviceId);

    if (device.status === 'unknown') {

      try {

        await this.createDevice({ projectId: deviceId });

      } catch {

        // deploy ya existía

      }

      device = await this.getDevice(deviceId);

      status = device.status ?? status;

    }



    if (status === 'connected' || status === 'connecting') return status;



    for (let attempt = 0; attempt < 8; attempt++) {

      await this.sleep(2500);

      status = await this.getSessionStatus(deviceId);

      if (status === 'connected' || status === 'connecting') return status;

    }



    await rebootBuilderBotCloudDeploy(deviceId);

    await this.sleep(4000);

    return this.getSessionStatus(deviceId);

  }



  async getQrImageBuffer(deviceId: string): Promise<Buffer> {

    if (!hasBuilderBot) {

      throw new DomainError('BuilderBot no está configurado en el servidor', 'BUILDERBOT_NOT_CONFIGURED');

    }



    const url = `${this.baseUrl()}/deploys/${encodeURIComponent(deviceId)}/qr`;

    const response = await fetch(url, { headers: this.authHeaders() });



    if (!response.ok) {

      const body = await response.text();

      throw new DomainError(`BuilderBot Cloud API error ${response.status}: ${body}`, 'BUILDERBOT_ERROR');

    }



    const contentType = response.headers.get('content-type') ?? '';

    const buffer = Buffer.from(await response.arrayBuffer());

    if (!buffer.length) {

      throw new DomainError('BuilderBot no devolvió un QR válido', 'BUILDERBOT_QR_EMPTY');

    }



    const isPng =
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47;

    if (contentType.includes('image/') || isPng) {

      return buffer;

    }



    const text = buffer.toString('utf8');

    try {

      const raw = JSON.parse(text) as JsonRecord;

      if (raw.error) {

        throw new DomainError(String(raw.error), 'BUILDERBOT_ERROR');

      }

      const qr = this.mapQr(raw);

      if (qr.qrBase64) return Buffer.from(qr.qrBase64, 'base64');

      if (qr.qrImageUrl?.startsWith('data:image')) {

        const base64 = qr.qrImageUrl.split(',')[1] ?? '';

        if (base64) return Buffer.from(base64, 'base64');

      }

    } catch (error) {

      if (error instanceof DomainError) throw error;

      if (/^[A-Za-z0-9+/=]+$/.test(text) && text.length > 100) {

        return Buffer.from(text, 'base64');

      }

    }



    throw new DomainError('BuilderBot no devolvió un QR válido', 'BUILDERBOT_QR_EMPTY');

  }



  async requestPairingCode(deviceId: string, phone: string): Promise<{ pairingCode?: string }> {

    try {

      const raw = await this.request<JsonRecord>(`/deploys/${encodeURIComponent(deviceId)}/connect`, {

        method: 'POST',

        body: JSON.stringify({ phone }),

      });

      const data = this.unwrap(raw);

      return {

        pairingCode: data.code ? String(data.code) : data.pairingCode ? String(data.pairingCode) : undefined,

      };

    } catch {

      throw new DomainError(

        'Emparejamiento por número no disponible. Usa el QR de BuilderBot Cloud.',

        'BUILDERBOT_CLOUD_CONNECT_IN_PANEL'

      );

    }

  }



  async updateDevice(deviceId: string, payload: Record<string, unknown>): Promise<void> {

    const body = {

      ...payload,

      webhook: payload.webhook ?? payload.webhookUrl,

      webhookUrl: payload.webhookUrl ?? payload.webhook,

    };



    let lastError: DomainError | null = null;

    try {
      await this.request(`/deploys/${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return;
    } catch (error) {
      lastError = error instanceof DomainError ? error : null;
    }

    try {
      await this.request(`/deploys/${encodeURIComponent(deviceId)}/webhook`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return;
    } catch (error) {
      if (error instanceof DomainError) lastError = error;
    }

    if (lastError) throw lastError;
    throw new DomainError(
      'No se pudo configurar el webhook en BuilderBot Cloud. Configúralo manualmente en el panel.',
      'BUILDERBOT_WEBHOOK_SYNC_FAILED'
    );
  }



  async sendTextMessage(input: SendTextMessageInput): Promise<void> {
    if (!hasBuilderBot) {
      throw new DomainError('BuilderBot no está configurado en el servidor', 'BUILDERBOT_NOT_CONFIGURED');
    }

    const content = input.message.trim();
    const projectId = input.deviceId;

    try {
      await this.postV2Message(projectId, input.phone, { messages: { content } });
      return;
    } catch (v2Error) {
      const legacyPayload = {
        projectId,
        phone: input.phone,
        to: input.phone,
        number: input.phone,
        message: content,
        text: content,
      };

      const paths = [
        {
          path: `/deploys/${encodeURIComponent(projectId)}/messages`,
          init: { method: 'POST', body: JSON.stringify(legacyPayload) },
        },
        { path: '/messages', init: { method: 'POST', body: JSON.stringify(legacyPayload) } },
      ];

      let lastError: DomainError | null = v2Error instanceof DomainError ? v2Error : null;

      for (const candidate of paths) {
        try {
          await this.request(candidate.path, candidate.init);
          return;
        } catch (error) {
          if (error instanceof DomainError) lastError = error;
          else throw error;
        }
      }

      throw lastError ?? new DomainError('No se pudo enviar el mensaje por BuilderBot Cloud', 'BUILDERBOT_ERROR');
    }
  }

  async sendButtonsMessage(input: SendButtonsMessageInput): Promise<void> {
    const buttons = input.buttons.slice(0, 3).map((btn) => ({
      body: btn.body,
      id: btn.id ?? btn.body,
    }));

    try {
      await this.postV2Message(input.deviceId, input.phone, {
        messages: {
          content: input.body.trim(),
          footer: input.footer?.trim(),
          buttons,
        },
      });
    } catch {
      const fallback = [input.body.trim(), ...buttons.map((b, i) => `${i + 1}. ${b.body}`)].join('\n');
      await this.sendTextMessage({ deviceId: input.deviceId, phone: input.phone, message: fallback });
    }
  }

  async sendListMessage(input: SendListMessageInput): Promise<void> {
    const sections = input.sections.map((section) => ({
      title: section.title,
      rows: section.rows.slice(0, 10).map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
      })),
    }));

    try {
      await this.postV2Message(input.deviceId, input.phone, {
        messages: {
          content: input.body.trim(),
          footer: input.footer?.trim(),
          list: {
            title: input.title?.trim(),
            buttonText: input.buttonText.trim(),
            sections,
          },
        },
      });
    } catch {
      const lines = sections.flatMap((s) =>
        s.rows.map((r) => `- ${r.title}${r.description ? `: ${r.description}` : ''}`)
      );
      const fallback = [input.body.trim(), ...lines].join('\n');
      await this.sendTextMessage({ deviceId: input.deviceId, phone: input.phone, message: fallback });
    }
  }

  private async postV2Message(
    projectId: string,
    phone: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!hasBuilderBot) {
      throw new DomainError('BuilderBot no está configurado en el servidor', 'BUILDERBOT_NOT_CONFIGURED');
    }

    const number = phone.replace(/\D/g, '');
    const v2Payload = {
      ...payload,
      number,
      checkIfExists: false,
    };

    const v2Url = resolveBuilderBotCloudMessagesUrl(projectId);
    const v2Response = await fetch(v2Url, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(v2Payload),
    });

    if (v2Response.ok) return;

    const v2ErrorBody = await v2Response.text();
    throw new DomainError(
      `BuilderBot Cloud API error ${v2Response.status}: ${v2ErrorBody}`,
      'BUILDERBOT_ERROR'
    );
  }

  async deleteDevice(deviceId: string): Promise<void> {

    try {

      await this.request(`/deploys/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });

    } catch {

      // deploy puede no existir

    }

  }



  async deleteProject(projectId: string): Promise<void> {

    await deleteBuilderBotCloudProject(projectId);

  }

}


