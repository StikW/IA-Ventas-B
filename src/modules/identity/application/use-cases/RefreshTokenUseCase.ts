import { inject, injectable } from 'tsyringe';
import { UseCase } from '../../../../shared/application/UseCase';
import { UnauthorizedError } from '../../../../shared/domain/errors/DomainError';
import { JwtService } from '../../../../shared/infrastructure/security/JwtService';
import { generateId, hashToken } from '../../../../shared/infrastructure/utils/crypto.utils';
import { IUserRepository, IRefreshTokenRepository } from '../../domain/repositories/IUserRepository';

export interface RefreshTokenInput {
  refreshToken: string;
}

export interface RefreshTokenOutput {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@injectable()
export class RefreshTokenUseCase implements UseCase<RefreshTokenInput, RefreshTokenOutput> {
  constructor(
    @inject('IUserRepository') private readonly userRepo: IUserRepository,
    @inject('IRefreshTokenRepository') private readonly refreshRepo: IRefreshTokenRepository,
    @inject(JwtService) private readonly jwtService: JwtService
  ) {}

  async execute(input: RefreshTokenInput): Promise<RefreshTokenOutput> {
    const payload = this.jwtService.verifyRefreshToken(input.refreshToken);
    const tokenHash = hashToken(input.refreshToken);
    const stored = await this.refreshRepo.findByTokenHash(tokenHash);

    if (!stored) {
      throw new UnauthorizedError('Refresh token inválido', 'INVALID_REFRESH_TOKEN');
    }

    const user = await this.userRepo.findById(payload.sub);
    if (!user || !user.isActive()) {
      throw new UnauthorizedError('Usuario no encontrado o inactivo', 'USER_INACTIVE');
    }

    await this.refreshRepo.revoke(stored.id, stored.userId);

    const accessToken = this.jwtService.generateAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    });

    const newRefreshToken = this.jwtService.generateRefreshToken({ sub: user.id });
    const refreshId = generateId();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.refreshRepo.save({
      id: refreshId,
      userId: user.id,
      tokenHash: hashToken(newRefreshToken),
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date().toISOString(),
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: this.jwtService.getAccessTokenExpiresInSeconds(),
    };
  }
}
