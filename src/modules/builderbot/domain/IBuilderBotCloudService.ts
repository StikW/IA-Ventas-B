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

export interface BuilderBotConfigData {
  tenantId: string;
  deviceId: string;
  deviceName: string;
  phone?: string;
  sessionStatus: BuilderBotSessionStatus;
  platformApiKeyPrefix?: string;
  webhookUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IBuilderBotCloudService {
  createDevice(name: string): Promise<BuilderBotDevice>;
  getDevice(deviceId: string): Promise<BuilderBotDevice>;
  getSessionStatus(deviceId: string): Promise<BuilderBotSessionStatus>;
  getQrCode(deviceId: string): Promise<BuilderBotQrResponse>;
  requestPairingCode(deviceId: string, phone: string): Promise<{ pairingCode?: string }>;
  updateDevice(deviceId: string, payload: Record<string, unknown>): Promise<void>;
  sendTextMessage(input: SendTextMessageInput): Promise<void>;
  deleteDevice(deviceId: string): Promise<void>;
}

export interface IBuilderBotConfigRepository {
  findByTenantId(tenantId: string): Promise<BuilderBotConfigData | null>;
  save(config: BuilderBotConfigData): Promise<void>;
  delete(tenantId: string): Promise<void>;
}
