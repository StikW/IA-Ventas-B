import { inject, injectable } from 'tsyringe';
import { UseCase } from '../../../../shared/application/UseCase';
import { hashToken } from '../../../../shared/infrastructure/utils/crypto.utils';
import { IRefreshTokenRepository } from '../../domain/repositories/IUserRepository';

export interface LogoutInput {
  refreshToken: string;
}

@injectable()
export class LogoutUseCase implements UseCase<LogoutInput, void> {
  constructor(
    @inject('IRefreshTokenRepository') private readonly refreshRepo: IRefreshTokenRepository
  ) {}

  async execute(input: LogoutInput): Promise<void> {
    const tokenHash = hashToken(input.refreshToken);
    const stored = await this.refreshRepo.findByTokenHash(tokenHash);
    if (stored) {
      await this.refreshRepo.revoke(stored.id, stored.userId);
    }
  }
}
