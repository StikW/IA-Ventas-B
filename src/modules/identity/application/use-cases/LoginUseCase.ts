import { inject, injectable } from 'tsyringe';
import { UseCase } from '../../../../shared/application/UseCase';
import { UnauthorizedError } from '../../../../shared/domain/errors/DomainError';
import { JwtService } from '../../../../shared/infrastructure/security/JwtService';
import { PasswordHasher } from '../../../../shared/infrastructure/security/PasswordHasher';
import { generateId, hashToken } from '../../../../shared/infrastructure/utils/crypto.utils';
import { IUserRepository, IRefreshTokenRepository } from '../../domain/repositories/IUserRepository';

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthOutput {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: ReturnType<import('../../domain/entities/User').User['toJSON']>;
}

@injectable()
export class LoginUseCase implements UseCase<LoginInput, AuthOutput> {
  constructor(
    @inject('IUserRepository') private readonly userRepo: IUserRepository,
    @inject('IRefreshTokenRepository') private readonly refreshRepo: IRefreshTokenRepository,
    @inject(JwtService) private readonly jwtService: JwtService,
    @inject(PasswordHasher) private readonly passwordHasher: PasswordHasher
  ) {}

  async execute(input: LoginInput): Promise<AuthOutput> {
    const user = await this.userRepo.findByEmail(input.email);
    if (!user || !user.isActive()) {
      throw new UnauthorizedError('Credenciales inválidas', 'INVALID_CREDENTIALS');
    }

    const valid = await this.passwordHasher.compare(input.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedError('Credenciales inválidas', 'INVALID_CREDENTIALS');
    }

    const now = new Date().toISOString();
    await this.userRepo.update(user.id, { lastLoginAt: now, updatedAt: now });

    const accessToken = this.jwtService.generateAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    });

    const refreshToken = this.jwtService.generateRefreshToken({ sub: user.id });
    const refreshId = generateId();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.refreshRepo.save({
      id: refreshId,
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: expiresAt.toISOString(),
      createdAt: now,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.jwtService.getAccessTokenExpiresInSeconds(),
      user: user.toJSON(),
    };
  }
}
