import { Request, Response, NextFunction } from 'express';
import { container } from 'tsyringe';
import { UnauthorizedError, ForbiddenError } from '../../domain/errors/DomainError';
import { IApiKeyRepository } from '../../../modules/tenant/domain/repositories/IConfigRepository';
import { hashToken } from '../../infrastructure/utils/crypto.utils';
import { BusinessRepositoryDynamo } from '../../../modules/tenant/infrastructure/persistence/BusinessRepositoryDynamo';

declare global {
  namespace Express {
    interface Request {
      apiKeyContext?: {
        tenantId: string;
        keyId: string;
      };
    }
  }
}

export async function apiKeyMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const rawKey = req.headers['x-api-key'] as string | undefined;
    if (!rawKey) {
      next(new UnauthorizedError('API Key requerida', 'API_KEY_REQUIRED'));
      return;
    }

    const apiKeyRepo = container.resolve<IApiKeyRepository>('IApiKeyRepository');
    const keyHash = hashToken(rawKey);
    const record = await apiKeyRepo.findByHash(keyHash);

    if (!record || record.revokedAt) {
      next(new UnauthorizedError('API Key inválida', 'INVALID_API_KEY'));
      return;
    }

    const businessRepo = container.resolve(BusinessRepositoryDynamo);
    const business = await businessRepo.findById(record.tenantId);
    if (!business || !business.isActive()) {
      next(new ForbiddenError('Negocio inactivo o no encontrado', 'TENANT_INACTIVE'));
      return;
    }

    req.apiKeyContext = { tenantId: record.tenantId, keyId: record.id };
    next();
  } catch (err) {
    next(err);
  }
}
