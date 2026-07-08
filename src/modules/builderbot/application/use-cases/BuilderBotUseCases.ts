import { inject, injectable } from 'tsyringe';
import { TenantContext, UseCase } from '../../../../shared/application/UseCase';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../../shared/domain/errors/DomainError';
import { env, hasBuilderBot } from '../../../../shared/infrastructure/config/env';
import { resolveBuilderBotApiMode } from '../../infrastructure/builderBotApiMode';
import { UserRole } from '../../../identity/domain/entities/User.types';
import { IBusinessRepository } from '../../../tenant/domain/repositories/IBusinessRepository';
import {
  BuilderBotConfigData,
  BuilderBotSessionStatus,
  IBuilderBotCloudService,
  IBuilderBotConfigRepository,
} from '../../domain/IBuilderBotCloudService';

function resolveTenantId(actor: TenantContext): string {
  if (actor.role !== UserRole.NEGOCIO || !actor.tenantId) {
    throw new ForbiddenError('Solo usuarios NEGOCIO pueden gestionar WhatsApp');
  }
  return actor.tenantId;
}

@injectable()
export class ProvisionBuilderBotForTenantUseCase
  implements UseCase<{ tenantId: string; businessName: string; businessSlug: string }, BuilderBotConfigData | null>
{
  constructor(
    @inject('IBuilderBotCloudService') private readonly builderBot: IBuilderBotCloudService,
    @inject('IBuilderBotConfigRepository') private readonly repo: IBuilderBotConfigRepository
  ) {}

  async execute(input: { tenantId: string; businessName: string; businessSlug: string }): Promise<BuilderBotConfigData | null> {
    if (!hasBuilderBot) return null;

    const existing = await this.repo.findByTenantId(input.tenantId);
    if (existing) return existing;

    const device = await this.builderBot.createDevice(`${input.businessName} (${input.businessSlug})`);
    const now = new Date().toISOString();
    const webhookUrl = `${env.APP_PUBLIC_URL.replace(/\/$/, '')}${env.API_PREFIX}/webhooks/builderbot/${input.tenantId}`;

    try {
      await this.builderBot.updateDevice(device.deviceId, { webhook: webhookUrl });
    } catch {
      // webhook opcional según plan/API
    }

    const config: BuilderBotConfigData = {
      tenantId: input.tenantId,
      deviceId: device.deviceId,
      deviceName: input.businessName,
      phone: device.phone,
      sessionStatus: device.status ?? 'disconnected',
      webhookUrl,
      createdAt: now,
      updatedAt: now,
    };

    await this.repo.save(config);
    return config;
  }
}

@injectable()
export class GetBuilderBotConfigUseCase implements UseCase<{ actor: TenantContext }, object> {
  constructor(
    @inject('IBuilderBotCloudService') private readonly builderBot: IBuilderBotCloudService,
    @inject('IBuilderBotConfigRepository') private readonly repo: IBuilderBotConfigRepository
  ) {}

  async execute(input: { actor: TenantContext }) {
    const tenantId = resolveTenantId(input.actor);
    const config = await this.repo.findByTenantId(tenantId);

    if (!config) {
      return {
        configured: false,
        enabled: hasBuilderBot,
        message: hasBuilderBot
          ? 'WhatsApp aún no provisionado. Pulsa «Activar WhatsApp» para crear el device.'
          : 'BuilderBot no configurado en el servidor',
      };
    }

    let sessionStatus: BuilderBotSessionStatus = config.sessionStatus;
    let phone = config.phone;

    if (hasBuilderBot) {
      try {
        sessionStatus = await this.builderBot.getSessionStatus(config.deviceId);
        const device = await this.builderBot.getDevice(config.deviceId);
        phone = device.phone ?? phone;
      } catch {
        // mantener último estado conocido
      }
    }

    return {
      configured: true,
      enabled: hasBuilderBot,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      phone,
      sessionStatus,
      platformApiKeyPrefix: config.platformApiKeyPrefix,
      webhookUrl: config.webhookUrl,
      updatedAt: config.updatedAt,
    };
  }
}

@injectable()
export class GetBuilderBotQrUseCase implements UseCase<{ actor: TenantContext }, object> {
  constructor(
    @inject('IBuilderBotCloudService') private readonly builderBot: IBuilderBotCloudService,
    @inject('IBuilderBotConfigRepository') private readonly repo: IBuilderBotConfigRepository
  ) {}

  async execute(input: { actor: TenantContext }) {
    const tenantId = resolveTenantId(input.actor);
    const config = await this.repo.findByTenantId(tenantId);
    if (!config) throw new NotFoundError('WhatsApp no provisionado para este negocio');

    const qr = await this.builderBot.getQrCode(config.deviceId);
    return qr;
  }
}

@injectable()
export class ConnectBuilderBotPhoneUseCase
  implements UseCase<{ actor: TenantContext; phone: string }, { pairingCode?: string }>
{
  constructor(
    @inject('IBuilderBotCloudService') private readonly builderBot: IBuilderBotCloudService,
    @inject('IBuilderBotConfigRepository') private readonly repo: IBuilderBotConfigRepository
  ) {}

  async execute(input: { actor: TenantContext; phone: string }) {
    const tenantId = resolveTenantId(input.actor);
    const config = await this.repo.findByTenantId(tenantId);
    if (!config) throw new NotFoundError('WhatsApp no provisionado para este negocio');

    const result = await this.builderBot.requestPairingCode(config.deviceId, input.phone);

    await this.repo.save({
      ...config,
      phone: input.phone,
      sessionStatus: 'connecting',
      updatedAt: new Date().toISOString(),
    });

    return result;
  }
}

@injectable()
export class RefreshBuilderBotStatusUseCase implements UseCase<{ actor: TenantContext }, object> {
  constructor(
    @inject('IBuilderBotCloudService') private readonly builderBot: IBuilderBotCloudService,
    @inject('IBuilderBotConfigRepository') private readonly repo: IBuilderBotConfigRepository
  ) {}

  async execute(input: { actor: TenantContext }) {
    const tenantId = resolveTenantId(input.actor);
    const config = await this.repo.findByTenantId(tenantId);
    if (!config) throw new NotFoundError('WhatsApp no provisionado para este negocio');

    const sessionStatus = await this.builderBot.getSessionStatus(config.deviceId);
    const device = await this.builderBot.getDevice(config.deviceId);

    const updated = {
      ...config,
      sessionStatus,
      phone: device.phone ?? config.phone,
      updatedAt: new Date().toISOString(),
    };
    await this.repo.save(updated);

    return {
      sessionStatus: updated.sessionStatus,
      phone: updated.phone,
    };
  }
}

@injectable()
export class LinkBuilderBotBotUseCase
  implements UseCase<{ actor: TenantContext; botId: string; deviceName?: string }, BuilderBotConfigData>
{
  constructor(
    @inject('IBuilderBotCloudService') private readonly builderBot: IBuilderBotCloudService,
    @inject('IBuilderBotConfigRepository') private readonly repo: IBuilderBotConfigRepository,
    @inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository
  ) {}

  async execute(input: { actor: TenantContext; botId: string; deviceName?: string }): Promise<BuilderBotConfigData> {
    if (!hasBuilderBot) {
      throw new ForbiddenError('BuilderBot no está configurado en el servidor');
    }

    const tenantId = resolveTenantId(input.actor);
    const existing = await this.repo.findByTenantId(tenantId);
    if (existing) {
      throw new ConflictError('WhatsApp ya está vinculado para este negocio');
    }

    const botId = input.botId.trim();
    let sessionStatus: BuilderBotSessionStatus = 'unknown';
    let phone: string | undefined;

    try {
      const device = await this.builderBot.getDevice(botId);
      sessionStatus = device.status ?? 'unknown';
      phone = device.phone;
    } catch {
      // En cloud-v2 el bot puede existir aunque la API no exponga GET del bot
    }

    const business = await this.businessRepo.findById(tenantId);
    const deviceName = input.deviceName?.trim() || business?.name || 'Bot WhatsApp';
    const now = new Date().toISOString();
    const webhookUrl = `${env.APP_PUBLIC_URL.replace(/\/$/, '')}${env.API_PREFIX}/webhooks/builderbot/${tenantId}`;

    try {
      await this.builderBot.updateDevice(botId, { webhook: webhookUrl, webhookUrl });
    } catch {
      // configurar webhook manualmente en BuilderBot Cloud si la API no lo soporta
    }

    const config: BuilderBotConfigData = {
      tenantId,
      deviceId: botId,
      deviceName,
      phone,
      sessionStatus,
      webhookUrl,
      createdAt: now,
      updatedAt: now,
    };

    await this.repo.save(config);
    return config;
  }
}

@injectable()
export class ProvisionWhatsAppUseCase implements UseCase<{ actor: TenantContext }, BuilderBotConfigData | null> {
  constructor(
    @inject(ProvisionBuilderBotForTenantUseCase) private readonly provision: ProvisionBuilderBotForTenantUseCase,
    @inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository,
    @inject('IBuilderBotConfigRepository') private readonly repo: IBuilderBotConfigRepository
  ) {}

  async execute(input: { actor: TenantContext }): Promise<BuilderBotConfigData | null> {
    const tenantId = resolveTenantId(input.actor);
    const existing = await this.repo.findByTenantId(tenantId);
    if (existing) return existing;

    if (resolveBuilderBotApiMode() === 'cloud-v2') {
      throw new ForbiddenError(
        'El modo cloud-v2 no soporta provisionamiento automático. Usa BUILDERBOT_API_MODE=wa-api con API key de console.builderbot.app.'
      );
    }

    const business = await this.businessRepo.findById(tenantId);
    if (!business) throw new NotFoundError('Negocio no encontrado');

    const config = await this.provision.execute({
      tenantId,
      businessName: business.name,
      businessSlug: business.slug,
    });

    if (config) {
      await this.repo.save(config);
    }

    return config;
  }
}
