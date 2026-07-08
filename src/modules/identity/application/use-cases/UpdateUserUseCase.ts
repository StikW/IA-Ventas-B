import { inject, injectable } from 'tsyringe';
import { TenantContext, UseCase } from '../../../../shared/application/UseCase';
import { ForbiddenError, NotFoundError } from '../../../../shared/domain/errors/DomainError';
import { User } from '../../domain/entities/User';
import { UserRole, UserStatus } from '../../domain/entities/User.types';
import { IUserRepository } from '../../domain/repositories/IUserRepository';

@injectable()
export class UpdateUserUseCase
  implements
    UseCase<
      {
        id: string;
        actor: TenantContext;
        profile?: { firstName?: string; lastName?: string; phone?: string };
        status?: UserStatus;
      },
      ReturnType<User['toJSON']>
    >
{
  constructor(@inject('IUserRepository') private readonly userRepo: IUserRepository) {}

  async execute(input: {
    id: string;
    actor: TenantContext;
    profile?: { firstName?: string; lastName?: string; phone?: string };
    status?: UserStatus;
  }) {
    const user = await this.userRepo.findById(input.id);
    if (!user) throw new NotFoundError('Usuario no encontrado');

    if (input.actor.role !== UserRole.ADMIN && user.tenantId !== input.actor.tenantId) {
      throw new ForbiddenError('Acceso denegado');
    }

    if (input.actor.role !== UserRole.ADMIN && input.status === UserStatus.INACTIVE && user.id === input.actor.userId) {
      throw new ForbiddenError('No puedes desactivarte a ti mismo');
    }

    const updated = await this.userRepo.update(user.id, {
      profile: input.profile ? { ...user.profile, ...input.profile } : undefined,
      status: input.status,
      updatedAt: new Date().toISOString(),
    });

    return updated.toJSON();
  }
}

@injectable()
export class DeactivateUserUseCase implements UseCase<{ id: string; actor: TenantContext }, ReturnType<User['toJSON']>> {
  constructor(@inject('IUserRepository') private readonly userRepo: IUserRepository) {}

  async execute(input: { id: string; actor: TenantContext }) {
    const user = await this.userRepo.findById(input.id);
    if (!user) throw new NotFoundError('Usuario no encontrado');

    if (input.actor.role !== UserRole.ADMIN && user.tenantId !== input.actor.tenantId) {
      throw new ForbiddenError('Acceso denegado');
    }

    if (user.id === input.actor.userId) {
      throw new ForbiddenError('No puedes desactivarte a ti mismo');
    }

    const updated = await this.userRepo.update(user.id, {
      status: UserStatus.INACTIVE,
      updatedAt: new Date().toISOString(),
    });

    return updated.toJSON();
  }
}
