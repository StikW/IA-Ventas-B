import { injectable } from 'tsyringe';
import {
  BuilderBotDevice,
  BuilderBotQrResponse,
  BuilderBotSessionStatus,
  IBuilderBotCloudService,
  SendTextMessageInput,
} from '../domain/IBuilderBotCloudService';
import { resolveBuilderBotApiMode } from './builderBotApiMode';
import { BuilderBotCloudV2Adapter } from './BuilderBotCloudV2Adapter';
import { BuilderBotWaApiAdapter } from './BuilderBotWaApiAdapter';

@injectable()
export class BuilderBotCloudAdapter implements IBuilderBotCloudService {
  constructor(
    private readonly waApi = new BuilderBotWaApiAdapter(),
    private readonly cloudV2 = new BuilderBotCloudV2Adapter()
  ) {}

  private delegate(): IBuilderBotCloudService {
    return resolveBuilderBotApiMode() === 'cloud-v2' ? this.cloudV2 : this.waApi;
  }

  createDevice(name: string): Promise<BuilderBotDevice> {
    return this.delegate().createDevice(name);
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

  requestPairingCode(deviceId: string, phone: string): Promise<{ pairingCode?: string }> {
    return this.delegate().requestPairingCode(deviceId, phone);
  }

  updateDevice(deviceId: string, payload: Record<string, unknown>): Promise<void> {
    return this.delegate().updateDevice(deviceId, payload);
  }

  sendTextMessage(input: SendTextMessageInput): Promise<void> {
    return this.delegate().sendTextMessage(input);
  }

  deleteDevice(deviceId: string): Promise<void> {
    return this.delegate().deleteDevice(deviceId);
  }
}
