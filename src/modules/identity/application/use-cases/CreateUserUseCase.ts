import { inject, injectable } from 'tsyringe';
import { TenantContext, UseCase } from '../../../../shared/application/UseCase';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../../shared/domain/errors/DomainError';
import { PasswordHasher } from '../../../../shared/infrastructure/security/PasswordHasher';
import { generateId } from '../../../../shared/infrastructure/utils/crypto.utils';
import { User } from '../../domain/entities/User';
import { UserRole, UserStatus } from '../../domain/entities/User.types';
import { IUserRepository } from '../../domain/repositories/IUserRepository';

export interface CreateUserInput {
  email: string;
  password: string;
  role: UserRole;
  tenantId?: string | null;
  profile: { firstName: string; lastName: string; phone?: string };
  actor: TenantContext;
}

@injectable()
export class CreateUserUseCase implements UseCase<CreateUserInput, ReturnType<User['toJSON']>> {
  constructor(
    @inject('IUserRepository') private readonly userRepo: IUserRepository,
    @inject(PasswordHasher) private readonly passwordHasher: PasswordHasher
  ) {}

  async execute(input: CreateUserInput): Promise<ReturnType<User['toJSON']>> {
    if (input.actor.role !== UserRole.ADMIN && input.role === UserRole.ADMIN) {
      throw new ForbiddenError('No puedes crear usuarios ADMIN');
    }

    if (input.actor.role === UserRole.NEGOCIO) {
      if (input.role !== UserRole.NEGOCIO) {
        throw new ForbiddenError('Solo puedes crear usuarios NEGOCIO');
      }
      if (input.tenantId && input.tenantId !== input.actor.tenantId) {
        throw new ForbiddenError('No puedes crear usuarios en otro negocio');
      }
    }

    const tenantId =
      input.actor.role === UserRole.ADMIN
        ? input.role === UserRole.ADMIN
          ? null
          : (input.tenantId ?? null)
        : input.actor.tenantId;

    if (input.role === UserRole.NEGOCIO && !tenantId) {
      throw new ConflictError('Los usuarios NEGOCIO requieren un tenantId');
    }

    const existing = await this.userRepo.findByEmail(input.email);
    if (existing) {
      throw new ConflictError('El email ya está registrado', 'EMAIL_EXISTS');
    }

    const now = new Date().toISOString();
    const user = User.create(
      {
        email: input.email.toLowerCase(),
        passwordHash: await this.passwordHasher.hash(input.password),
        role: input.role,
        tenantId,
        status: UserStatus.ACTIVE,
        profile: input.profile,
        createdAt: now,
        updatedAt: now,
      },
      generateId()
    );

    await this.userRepo.save(user);
    return user.toJSON();
  }
}

@injectable()
export class GetUserUseCase implements UseCase<{ id: string; actor: TenantContext }, ReturnType<User['toJSON']>> {
  constructor(@inject('IUserRepository') private readonly userRepo: IUserRepository) {}

  async execute(input: { id: string; actor: TenantContext }): Promise<ReturnType<User['toJSON']>> {
    const user = await this.userRepo.findById(input.id);
    if (!user) throw new NotFoundError('Usuario no encontrado');

    if (input.actor.role !== UserRole.ADMIN && user.tenantId !== input.actor.tenantId) {
      throw new ForbiddenError('Acceso denegado');
    }

    return user.toJSON();
  }
}

@injectable()
export class ListUsersUseCase
  implements UseCase<{ actor: TenantContext; tenantId?: string; limit?: number; cursor?: string }, import('../../../../shared/application/UseCase').PaginatedResult<ReturnType<User['toJSON']>>>
{
  constructor(@inject('IUserRepository') private readonly userRepo: IUserRepository) {}

  async execute(input: {
    actor: TenantContext;
    tenantId?: string;
    limit?: number;
    cursor?: string;
  }) {
    if (input.actor.role === UserRole.ADMIN) {
      if (!input.tenantId) {
        return { data: [], hasMore: false };
      }
      const result = await this.userRepo.findByTenant(input.tenantId, {
        limit: input.limit,
        cursor: input.cursor,
      });
      return { ...result, data: result.data.map((u) => u.toJSON()) };
    }

    if (!input.actor.tenantId) {
      return { data: [], hasMore: false };
    }

    const result = await this.userRepo.findByTenant(input.actor.tenantId, {
      limit: input.limit,
      cursor: input.cursor,
    });
    return { ...result, data: result.data.map((u) => u.toJSON()) };
  }
}
