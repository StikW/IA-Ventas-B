import { Request, Response, NextFunction } from 'express';
import { container } from 'tsyringe';
import { JwtService } from '../../infrastructure/security/JwtService';
import { TenantContext } from '../../application/UseCase';
import { UnauthorizedError, ForbiddenError } from '../../domain/errors/DomainError';

declare global {
  namespace Express {
    interface Request {
      user?: TenantContext;
    }
  }
}

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Token requerido', 'TOKEN_REQUIRED');
    }

    const token = header.slice(7);
    const jwtService = container.resolve(JwtService);
    const payload = jwtService.verifyAccessToken(token);

    req.user = {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
      tenantId: payload.tenantId,
    };

    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('No autenticado'));
      return;
    }

    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError('Permisos insuficientes'));
      return;
    }

    next();
  };
}

export function tenantMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new UnauthorizedError('No autenticado'));
    return;
  }

  const headerTenantId = req.headers['x-tenant-id'] as string | undefined;

  if (req.user.role === 'ADMIN' && headerTenantId) {
    req.user = { ...req.user, tenantId: headerTenantId };
  }

  if (req.user.role === 'NEGOCIO' && req.params.tenantId && req.params.tenantId !== req.user.tenantId) {
    next(new ForbiddenError('Acceso a tenant denegado'));
    return;
  }

  next();
}
