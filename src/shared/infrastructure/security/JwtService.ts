import { injectable } from 'tsyringe';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { UnauthorizedError } from '../../domain/errors/DomainError';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  tenantId: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@injectable()
export class JwtService {
  generateAccessToken(payload: JwtPayload): string {
    return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
      expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    });
  }

  generateRefreshToken(payload: Pick<JwtPayload, 'sub'>): string {
    return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
      expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    });
  }

  verifyAccessToken(token: string): JwtPayload {
    try {
      return jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
    } catch {
      throw new UnauthorizedError('Token de acceso inválido o expirado', 'INVALID_ACCESS_TOKEN');
    }
  }

  verifyRefreshToken(token: string): Pick<JwtPayload, 'sub'> {
    try {
      return jwt.verify(token, env.JWT_REFRESH_SECRET) as Pick<JwtPayload, 'sub'>;
    } catch {
      throw new UnauthorizedError('Refresh token inválido o expirado', 'INVALID_REFRESH_TOKEN');
    }
  }

  getAccessTokenExpiresInSeconds(): number {
    return 15 * 60;
  }
}
