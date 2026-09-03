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

export interface BuilderBotButtonOption {
  /** ID estable para button_reply (WhatsApp Cloud). Si no se envía, se usa body. */
  id?: string;
  body: string;
}

export interface BuilderBotListRow {
  id: string;
  title: string;
  description?: string;
}

export interface BuilderBotListSection {
  title: string;
  rows: BuilderBotListRow[];
}

export interface SendImageMessageInput {
  deviceId: string;
  phone: string;
  /** URL pública de la imagen. WhatsApp la descarga, así que no puede requerir login. */
  imageUrl: string;
  /** Texto que acompaña a la imagen. Se envía igual aunque la imagen no llegue. */
  caption: string;
}

export interface SendButtonsMessageInput {
  deviceId: string;
  phone: string;
  body: string;
  footer?: string;
  buttons: BuilderBotButtonOption[];
}

export interface SendCtaUrlMessageInput {
  deviceId: string;
  phone: string;
  body: string;
  displayText: string;
  url: string;
  footer?: string;
}

export interface SendListMessageInput {
  deviceId: string;
  phone: string;
  body: string;
  buttonText: string;
  sections: BuilderBotListSection[];
  title?: string;
  footer?: string;
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
  /** Si es false, el webhook no dispara el agente (plantillas salientes siguen activas). */
  agentEnabled?: boolean;
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
  /** `false` cuando el transporte solo acepta texto y los botones se degradan a opciones escritas. */
  supportsInteractiveMessages(): boolean;
  sendButtonsMessage(input: SendButtonsMessageInput): Promise<void>;
  /** Foto de producto con su texto. Si el transporte no acepta media, envía solo el texto. */
  sendImageMessage(input: SendImageMessageInput): Promise<void>;
  sendCtaUrlMessage(input: SendCtaUrlMessageInput): Promise<void>;
  sendListMessage(input: SendListMessageInput): Promise<void>;
  deleteDevice(deviceId: string): Promise<void>;
  /** Elimina el proyecto completo en BuilderBot Cloud (cloud-v2). No-op en wa-api. */
  deleteProject(projectId: string): Promise<void>;
}

export interface IBuilderBotConfigRepository {
  findByTenantId(tenantId: string): Promise<BuilderBotConfigData | null>;
  save(config: BuilderBotConfigData): Promise<void>;
  delete(tenantId: string): Promise<void>;
}
