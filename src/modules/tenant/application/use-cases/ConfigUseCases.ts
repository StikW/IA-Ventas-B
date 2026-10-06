import { inject, injectable } from 'tsyringe';
import { TenantContext, UseCase } from '../../../../shared/application/UseCase';
import { ForbiddenError, NotFoundError } from '../../../../shared/domain/errors/DomainError';
import { generateId, hashToken } from '../../../../shared/infrastructure/utils/crypto.utils';
import crypto from 'crypto';
import { UserRole } from '../../../identity/domain/entities/User.types';
import { BusinessConfig } from '../../domain/entities/BusinessConfig';
import { BusinessProfileConfig } from '../../domain/entities/Config.types';
import { IBusinessRepository } from '../../domain/repositories/IBusinessRepository';
import { IApiKeyRepository, IConfigRepository } from '../../domain/repositories/IConfigRepository';

function resolveTenantId(actor: TenantContext, explicitTenantId?: string): string {
  if (actor.role === UserRole.ADMIN) {
    if (!explicitTenantId) throw new ForbiddenError('ADMIN debe enviar X-Tenant-Id o tenantId');
    return explicitTenantId;
  }
  if (!actor.tenantId) throw new ForbiddenError('Usuario sin tenant asignado');
  return actor.tenantId;
}

export interface BusinessSettingsView {
  tenantId: string;
  name: string;
  contactEmail: string;
  contactPhone: string;
  business: BusinessProfileConfig;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateBusinessSettingsInput extends Partial<BusinessProfileConfig> {
  name: string;
  contactEmail: string;
  contactPhone?: string;
}

/** Nombre y contacto salen del negocio; descripción, dirección y horario, del perfil. */
function toSettingsView(
  config: BusinessConfig,
  business: { name: string; contactEmail: string; contactPhone?: string }
): BusinessSettingsView {
  const json = config.toJSON();
  return {
    ...json,
    name: business.name,
    contactEmail: business.contactEmail,
    contactPhone: business.contactPhone ?? '',
  };
}

@injectable()
export class GetConfigUseCase implements UseCase<{ actor: TenantContext; tenantId?: string }, BusinessSettingsView> {
  constructor(
    @inject('IConfigRepository') private readonly configRepo: IConfigRepository,
    @inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository
  ) {}

  async execute(input: { actor: TenantContext; tenantId?: string }) {
    const tenantId = resolveTenantId(input.actor, input.tenantId);
    const business = await this.businessRepo.findById(tenantId);
    if (!business) throw new NotFoundError('Negocio no encontrado');

    let config = await this.configRepo.findByTenantId(tenantId);
    if (!config) {
      config = BusinessConfig.defaultForTenant(tenantId);
      await this.configRepo.save(config);
    }
    return toSettingsView(config, business);
  }
}

@injectable()
export class UpdateBusinessConfigUseCase
  implements UseCase<{ actor: TenantContext; tenantId?: string; business: UpdateBusinessSettingsInput }, BusinessSettingsView>
{
  constructor(
    @inject('IConfigRepository') private readonly configRepo: IConfigRepository,
    @inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository
  ) {}

  async execute(input: {
    actor: TenantContext;
    tenantId?: string;
    business: UpdateBusinessSettingsInput;
  }) {
    const tenantId = resolveTenantId(input.actor, input.tenantId);
    const existing = await this.businessRepo.findById(tenantId);
    if (!existing) throw new NotFoundError('Negocio no encontrado');

    const profile = input.business;
    const updatedBusiness = await this.businessRepo.update(tenantId, {
      name: profile.name.trim(),
      contactEmail: profile.contactEmail.trim(),
      contactPhone: profile.contactPhone?.trim() ?? '',
      updatedAt: new Date().toISOString(),
    });

    let config = await this.configRepo.findByTenantId(tenantId);
    if (!config) config = BusinessConfig.defaultForTenant(tenantId);

    const updated = config.updateBusiness({
      description: profile.description,
      address: profile.address,
      businessHours: profile.businessHours,
      bankAccountInfo: profile.bankAccountInfo,
      checkoutFormUrl: profile.checkoutFormUrl,
      checkoutMode: profile.checkoutMode,
    });
    await this.configRepo.save(updated);
    return toSettingsView(updated, updatedBusiness);
  }
}

@injectable()
export class RegenerateApiKeyUseCase
  implements UseCase<{ actor: TenantContext; tenantId?: string }, { apiKey: string; keyPrefix: string; createdAt: string }>
{
  constructor(@inject('IApiKeyRepository') private readonly apiKeyRepo: IApiKeyRepository) {}

  async execute(input: { actor: TenantContext; tenantId?: string }) {
    const tenantId = resolveTenantId(input.actor, input.tenantId);

    const existing = await this.apiKeyRepo.findByTenantId(tenantId);
    if (existing) {
      await this.apiKeyRepo.revoke(existing.id, tenantId);
    }

    const randomPart = crypto.randomBytes(24).toString('hex');
    const keyPrefix = tenantId.slice(0, 8);
    const rawKey = `bb_live_${keyPrefix}_${randomPart}`;
    const now = new Date().toISOString();

    await this.apiKeyRepo.save({
      id: generateId(),
      tenantId,
      keyHash: hashToken(rawKey),
      keyPrefix: `bb_live_${keyPrefix}`,
      createdAt: now,
    });

    return { apiKey: rawKey, keyPrefix: `bb_live_${keyPrefix}`, createdAt: now };
  }
}

@injectable()
export class GetApiKeyInfoUseCase
  implements UseCase<{ actor: TenantContext; tenantId?: string }, { keyPrefix: string; createdAt: string } | null>
{
  constructor(@inject('IApiKeyRepository') private readonly apiKeyRepo: IApiKeyRepository) {}

  async execute(input: { actor: TenantContext; tenantId?: string }) {
    const tenantId = resolveTenantId(input.actor, input.tenantId);
    const record = await this.apiKeyRepo.findByTenantId(tenantId);
    if (!record) return null;
    return { keyPrefix: record.keyPrefix, createdAt: record.createdAt };
  }
}
