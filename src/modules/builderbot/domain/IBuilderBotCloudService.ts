export type BuilderBotSessionStatus = 'disconnected' | 'connecting' | 'connected' | 'unknown';

export interface BuilderBotDevice {
  deviceId: string;
  name?: string;
  phone?: string;
  status?: BuilderBotSessionStatus;
}

export interface BuilderBotQrResponse {
  qrImageUrl?: string;
  qrBase64?: string;
  pairingCode?: string;
}

export interface SendTextMessageInput {
  deviceId: string;
  phone: string;
  message: string;
}

export interface CreateBuilderBotDeviceInput {
  /** Identificador del deploy en BuilderBot Cloud (POST /manager/deploys). */
  projectId: string;
  name?: string;
}

export interface BuilderBotConfigData {
  tenantId: string;
  deviceId: string;
  deviceName: string;
  phone?: string;
  sessionStatus: BuilderBotSessionStatus;
  platformApiKeyPrefix?: string;
  webhookUrl?: string;
  /** UUID del proyecto en BuilderBot Cloud (cloud-v2). */
  projectId?: string;
  /** URL del panel BBC para vincular WhatsApp en ventana emergente. */
  connectUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IBuilderBotCloudService {
  createDevice(input: CreateBuilderBotDeviceInput): Promise<BuilderBotDevice>;
  getDevice(deviceId: string): Promise<BuilderBotDevice>;
  getSessionStatus(deviceId: string): Promise<BuilderBotSessionStatus>;
  getQrCode(deviceId: string): Promise<BuilderBotQrResponse>;
  /** Asegura que el deploy exista y esté listo para mostrar QR. */
  ensureDeployReady(deviceId: string): Promise<BuilderBotSessionStatus>;
  /** Devuelve bytes PNG del QR (cloud-v2 manager API). */
  getQrImageBuffer(deviceId: string): Promise<Buffer>;
  requestPairingCode(deviceId: string, phone: string): Promise<{ pairingCode?: string }>;
  updateDevice(deviceId: string, payload: Record<string, unknown>): Promise<void>;
  sendTextMessage(input: SendTextMessageInput): Promise<void>;
  deleteDevice(deviceId: string): Promise<void>;
  /** Elimina el proyecto completo en BuilderBot Cloud (cloud-v2). No-op en wa-api. */
  deleteProject(projectId: string): Promise<void>;
}

export interface IBuilderBotConfigRepository {
  findByTenantId(tenantId: string): Promise<BuilderBotConfigData | null>;
  save(config: BuilderBotConfigData): Promise<void>;
  delete(tenantId: string): Promise<void>;
}
