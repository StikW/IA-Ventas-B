import { injectable } from 'tsyringe';
import {
  BuilderBotDevice,
  BuilderBotQrResponse,
  BuilderBotSessionStatus,
  CreateBuilderBotDeviceInput,
  IBuilderBotCloudService,
  SendTextMessageInput,
  SendButtonsMessageInput,
  SendCtaUrlMessageInput,
  SendImageMessageInput,
  SendListMessageInput,
} from '../domain/IBuilderBotCloudService';
import { resolveBuilderBotApiMode } from './builderBotApiMode';
import { BuilderBotCloudV2Adapter } from './BuilderBotCloudV2Adapter';
import { BuilderBotWaApiAdapter } from './BuilderBotWaApiAdapter';

@injectable()
export class BuilderBotCloudAdapter implements IBuilderBotCloudService {
  private readonly waApi = new BuilderBotWaApiAdapter();
  private readonly cloudV2 = new BuilderBotCloudV2Adapter();

  private delegate(): IBuilderBotCloudService {
    return resolveBuilderBotApiMode() === 'cloud-v2' ? this.cloudV2 : this.waApi;
  }

  createDevice(input: CreateBuilderBotDeviceInput): Promise<BuilderBotDevice> {
    return this.delegate().createDevice(input);
  }

  getDevice(deviceId: string): Promise<BuilderBotDevice> {
    return this.delegate().getDevice(deviceId);
  }

  getSessionStatus(deviceId: string): Promise<BuilderBotSessionStatus> {
    return this.delegate().getSessionStatus(deviceId);
  }

  getQrCode(deviceId: string): Promise<BuilderBotQrResponse> {
    return this.delegate().getQrCode(deviceId);
  }

  ensureDeployReady(deviceId: string): Promise<BuilderBotSessionStatus> {
    return this.delegate().ensureDeployReady(deviceId);
  }

  getQrImageBuffer(deviceId: string): Promise<Buffer> {
    return this.delegate().getQrImageBuffer(deviceId);
  }

  requestPairingCode(deviceId: string, phone: string): Promise<{ pairingCode?: string }> {
    return this.delegate().requestPairingCode(deviceId, phone);
  }

  updateDevice(deviceId: string, payload: Record<string, unknown>): Promise<void> {
    return this.delegate().updateDevice(deviceId, payload);
  }

  sendTextMessage(input: SendTextMessageInput): Promise<void> {
    return this.delegate().sendTextMessage(input);
  }

  supportsInteractiveMessages(): boolean {
    return this.delegate().supportsInteractiveMessages();
  }

  sendButtonsMessage(input: SendButtonsMessageInput): Promise<void> {
    return this.delegate().sendButtonsMessage(input);
  }

  sendImageMessage(input: SendImageMessageInput): Promise<void> {
    return this.delegate().sendImageMessage(input);
  }

  sendCtaUrlMessage(input: SendCtaUrlMessageInput): Promise<void> {
    return this.delegate().sendCtaUrlMessage(input);
  }

  sendListMessage(input: SendListMessageInput): Promise<void> {
    return this.delegate().sendListMessage(input);
  }

  deleteDevice(deviceId: string): Promise<void> {
    return this.delegate().deleteDevice(deviceId);
  }

  deleteProject(projectId: string): Promise<void> {
    return this.delegate().deleteProject(projectId);
  }
}
