import { inject, injectable } from 'tsyringe';
import { TenantContext, UseCase } from '../../../../shared/application/UseCase';
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '../../../../shared/domain/errors/DomainError';
import { env, hasBuilderBot } from '../../../../shared/infrastructure/config/env';
import { buildBuilderBotProjectId } from '../../infrastructure/builderBotProjectId';
import { resolveBuilderBotApiMode } from '../../infrastructure/builderBotApiMode';
import { createBuilderBotCloudProject } from '../../infrastructure/BuilderBotMcpHttpClient';
import { buildBuilderBotConnectUrl } from '../../infrastructure/builderBotConnectUrl';
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

    const mode = resolveBuilderBotApiMode();
    let projectId: string;
    let connectUrl: string | undefined;

    if (mode === 'cloud-v2') {
      const project = await createBuilderBotCloudProject(input.businessName);
      projectId = project.projectId;
      connectUrl = buildBuilderBotConnectUrl(projectId);
    } else {
      projectId = buildBuilderBotProjectId(input.businessSlug);
    }

    const device = await this.builderBot.createDevice({
      projectId,
      name: input.businessName,
    });
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
      projectId: mode === 'cloud-v2' ? projectId : undefined,
      connectUrl,
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
          ? 'WhatsApp aún no provisionado. Pulsa «Activar WhatsApp» para crear el deploy en BuilderBot Cloud.'
          : 'BuilderBot no configurado en el servidor. Agrega BUILDERBOT_API_KEY en el .env del servidor.',
      };
    }

    if (!config.deviceId?.trim()) {
      return {
        configured: false,
        enabled: hasBuilderBot,
        message: 'Configuración de WhatsApp incompleta. Pulsa «Activar WhatsApp» de nuevo.',
      };
    }

    // Estado guardado en DB; refresh en vivo vía POST /builderbot/refresh-status
    const sessionStatus: BuilderBotSessionStatus = config.sessionStatus ?? 'unknown';
    const phone = config.phone;

    return {
      configured: true,
      enabled: hasBuilderBot,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      phone,
      sessionStatus,
      platformApiKeyPrefix: config.platformApiKeyPrefix,
      webhookUrl: config.webhookUrl,
      projectId: config.projectId ?? config.deviceId,
      connectUrl:
        config.connectUrl ??
        (resolveBuilderBotApiMode() === 'cloud-v2'
          ? buildBuilderBotConnectUrl(config.projectId ?? config.deviceId)
          : undefined),
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

    const projectId = config.projectId ?? config.deviceId;
    await this.builderBot.ensureDeployReady(projectId);

    const qr = await this.builderBot.getQrCode(projectId);
    return qr;
  }
}

@injectable()
export class GetBuilderBotQrImageUseCase implements UseCase<{ actor: TenantContext }, Buffer> {
  constructor(
    @inject('IBuilderBotCloudService') private readonly builderBot: IBuilderBotCloudService,
    @inject('IBuilderBotConfigRepository') private readonly repo: IBuilderBotConfigRepository
  ) {}

  async execute(input: { actor: TenantContext }): Promise<Buffer> {
    const tenantId = resolveTenantId(input.actor);
    const config = await this.repo.findByTenantId(tenantId);
    if (!config) throw new NotFoundError('WhatsApp no provisionado para este negocio');

    const projectId = config.projectId ?? config.deviceId;
    const status = await this.builderBot.ensureDeployReady(projectId);
    if (status === 'connected') {
      throw new DomainError('WhatsApp ya está conectado', 'BUILDERBOT_ALREADY_CONNECTED');
    }

    return this.builderBot.getQrImageBuffer(projectId);
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
      projectId: resolveBuilderBotApiMode() === 'cloud-v2' ? botId : undefined,
      connectUrl:
        resolveBuilderBotApiMode() === 'cloud-v2' ? buildBuilderBotConnectUrl(botId) : undefined,
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
