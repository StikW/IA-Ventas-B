import { inject, injectable } from 'tsyringe';
import { TenantContext, UseCase } from '../../../../shared/application/UseCase';
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '../../../../shared/domain/errors/DomainError';
import { hasBuilderBot } from '../../../../shared/infrastructure/config/env';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { PasswordHasher } from '../../../../shared/infrastructure/security/PasswordHasher';
import { generateId, slugify } from '../../../../shared/infrastructure/utils/crypto.utils';
import { User } from '../../../identity/domain/entities/User';
import { UserRole, UserStatus } from '../../../identity/domain/entities/User.types';
import { IUserRepository } from '../../../identity/domain/repositories/IUserRepository';
import { Business } from '../../domain/entities/Business';
import { BusinessStatus } from '../../domain/entities/Business.types';
import { IBusinessRepository } from '../../domain/repositories/IBusinessRepository';
import { ProvisionBuilderBotForTenantUseCase } from '../../../builderbot/application/use-cases/BuilderBotUseCases';
import { RegenerateApiKeyUseCase } from './ConfigUseCases';
import { IBuilderBotConfigRepository } from '../../../builderbot/domain/IBuilderBotCloudService';
import { TenantDeletionService, TenantDeletionSummary } from '../services/TenantDeletionService';

export interface CreateBusinessOwnerInput {
  firstName: string;
  lastName: string;
  email?: string;
  password: string;
  phone?: string;
}

export interface CreateBusinessInput {
  name: string;
  slug?: string;
  contactEmail: string;
  contactPhone?: string;
  owner: CreateBusinessOwnerInput;
  actor: TenantContext;
}

export interface CreateBusinessResult {
  business: ReturnType<Business['toJSON']>;
  owner: ReturnType<User['toJSON']>;
  builderBot?: {
    deviceId: string;
    projectId?: string;
    connectUrl?: string;
    sessionStatus: string;
  } | null;
  builderBotWarning?: string;
  platformApiKey?: string;
}

@injectable()
export class CreateBusinessUseCase implements UseCase<CreateBusinessInput, CreateBusinessResult> {
  constructor(
    @inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository,
    @inject('IUserRepository') private readonly userRepo: IUserRepository,
    @inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @inject(ProvisionBuilderBotForTenantUseCase) private readonly provisionBuilderBot: ProvisionBuilderBotForTenantUseCase,
    @inject(RegenerateApiKeyUseCase) private readonly regenerateApiKey: RegenerateApiKeyUseCase,
    @inject('IBuilderBotConfigRepository') private readonly builderBotRepo: IBuilderBotConfigRepository
  ) {}

  async execute(input: CreateBusinessInput): Promise<CreateBusinessResult> {
    if (input.actor.role !== UserRole.ADMIN) {
      throw new ForbiddenError('Solo ADMIN puede crear negocios');
    }

    const slug = input.slug ?? slugify(input.name);
    const existing = await this.businessRepo.findBySlug(slug);
    if (existing) {
      throw new ConflictError('El slug ya está en uso', 'SLUG_EXISTS');
    }

    const ownerEmail = (input.owner.email ?? input.contactEmail).toLowerCase();
    const existingUser = await this.userRepo.findByEmail(ownerEmail);
    if (existingUser) {
      throw new ConflictError('El email del usuario ya está registrado', 'EMAIL_EXISTS');
    }

    const now = new Date().toISOString();
    const businessId = generateId();
    const business = Business.create(
      {
        name: input.name,
        slug,
        status: BusinessStatus.ACTIVE,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone,
        createdBy: input.actor.userId,
        createdAt: now,
        updatedAt: now,
      },
      businessId
    );

    await this.businessRepo.save(business);

    const owner = User.create(
      {
        email: ownerEmail,
        passwordHash: await this.passwordHasher.hash(input.owner.password),
        role: UserRole.NEGOCIO,
        tenantId: businessId,
        status: UserStatus.ACTIVE,
        profile: {
          firstName: input.owner.firstName,
          lastName: input.owner.lastName,
          phone: input.owner.phone ?? input.contactPhone,
        },
        createdAt: now,
        updatedAt: now,
      },
      generateId()
    );

    await this.userRepo.save(owner);

    const apiKeyResult = await this.regenerateApiKey.execute({
      actor: input.actor,
      tenantId: businessId,
    });

    let bbConfig = null;
    let builderBotWarning: string | undefined;

    if (hasBuilderBot) {
      try {
        bbConfig = await this.provisionBuilderBot.execute({
          tenantId: businessId,
          businessName: input.name,
          businessSlug: slug,
        });

        if (bbConfig) {
          await this.builderBotRepo.save({
            ...bbConfig,
            platformApiKeyPrefix: apiKeyResult.keyPrefix,
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        const message =
          err instanceof DomainError
            ? err.message
            : 'No se pudo provisionar WhatsApp. Revisa BUILDERBOT_API_KEY en .env';

        builderBotWarning = message;
        logger.warn({ err, tenantId: businessId, slug }, 'Negocio creado sin WhatsApp provisionado');
      }
    }

    return {
      business: business.toJSON(),
      owner: owner.toJSON(),
      builderBot: bbConfig
        ? {
            deviceId: bbConfig.deviceId,
            projectId: bbConfig.projectId ?? bbConfig.deviceId,
            connectUrl: bbConfig.connectUrl,
            sessionStatus: bbConfig.sessionStatus,
          }
        : null,
      builderBotWarning,
      platformApiKey: apiKeyResult.apiKey,
    };
  }
}

@injectable()
export class GetBusinessUseCase
  implements UseCase<{ id: string; actor: TenantContext }, ReturnType<Business['toJSON']>>
{
  constructor(@inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository) {}

  async execute(input: { id: string; actor: TenantContext }): Promise<ReturnType<Business['toJSON']>> {
    const business = await this.businessRepo.findById(input.id);
    if (!business) throw new NotFoundError('Negocio no encontrado');

    if (input.actor.role !== UserRole.ADMIN && input.actor.tenantId !== business.id) {
      throw new ForbiddenError('Acceso denegado');
    }

    return business.toJSON();
  }
}

@injectable()
export class ListBusinessesUseCase
  implements
    UseCase<
      { actor: TenantContext; status?: string; limit?: number; cursor?: string },
      import('../../../../shared/application/UseCase').PaginatedResult<ReturnType<Business['toJSON']>>
    >
{
  constructor(@inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository) {}

  async execute(input: { actor: TenantContext; status?: string; limit?: number; cursor?: string }) {
    if (input.actor.role !== UserRole.ADMIN) {
      throw new ForbiddenError('Solo ADMIN puede listar negocios');
    }

    const result = await this.businessRepo.listByStatus(input.status ?? null, {
      limit: input.limit,
      cursor: input.cursor,
    });

    return { ...result, data: result.data.map((b) => b.toJSON()) };
  }
}

@injectable()
export class UpdateBusinessUseCase
  implements
    UseCase<
      {
        id: string;
        name?: string;
        slug?: string;
        contactEmail?: string;
        contactPhone?: string;
        actor: TenantContext;
      },
      ReturnType<Business['toJSON']>
    >
{
  constructor(@inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository) {}

  async execute(input: {
    id: string;
    name?: string;
    slug?: string;
    contactEmail?: string;
    contactPhone?: string;
    actor: TenantContext;
  }): Promise<ReturnType<Business['toJSON']>> {
    if (input.actor.role !== UserRole.ADMIN) {
      throw new ForbiddenError('Solo ADMIN puede editar negocios');
    }

    const business = await this.businessRepo.update(input.id, {
      name: input.name,
      slug: input.slug,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      updatedAt: new Date().toISOString(),
    });

    return business.toJSON();
  }
}

@injectable()
export class ActivateBusinessUseCase implements UseCase<{ id: string; actor: TenantContext }, ReturnType<Business['toJSON']>> {
  constructor(@inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository) {}

  async execute(input: { id: string; actor: TenantContext }): Promise<ReturnType<Business['toJSON']>> {
    if (input.actor.role !== UserRole.ADMIN) throw new ForbiddenError('Solo ADMIN');

    const existing = await this.businessRepo.findById(input.id);
    if (!existing) throw new NotFoundError('Negocio no encontrado');

    const activated = existing.activate();
    await this.businessRepo.update(input.id, {
      status: activated.status,
      updatedAt: activated.updatedAt,
    });

    return activated.toJSON();
  }
}

@injectable()
export class DeactivateBusinessUseCase implements UseCase<{ id: string; actor: TenantContext }, ReturnType<Business['toJSON']>> {
  constructor(@inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository) {}

  async execute(input: { id: string; actor: TenantContext }): Promise<ReturnType<Business['toJSON']>> {
    if (input.actor.role !== UserRole.ADMIN) throw new ForbiddenError('Solo ADMIN');

    const existing = await this.businessRepo.findById(input.id);
    if (!existing) throw new NotFoundError('Negocio no encontrado');

    const deactivated = existing.deactivate();
    await this.businessRepo.update(input.id, {
      status: deactivated.status,
      updatedAt: deactivated.updatedAt,
    });

    return deactivated.toJSON();
  }
}

@injectable()
export class DeleteBusinessUseCase
  implements UseCase<{ id: string; actor: TenantContext }, TenantDeletionSummary>
{
  constructor(@inject(TenantDeletionService) private readonly tenantDeletion: TenantDeletionService) {}

  async execute(input: { id: string; actor: TenantContext }): Promise<TenantDeletionSummary> {
    if (input.actor.role !== UserRole.ADMIN) {
      throw new ForbiddenError('Solo ADMIN puede eliminar negocios');
    }

    return this.tenantDeletion.deleteTenant(input.id);
  }
}
