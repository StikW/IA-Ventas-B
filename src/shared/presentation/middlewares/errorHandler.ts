import { Request, Response, NextFunction } from 'express';
import { DomainError, ValidationError } from '../../domain/errors/DomainError';
import { logger } from '../../infrastructure/logger/logger';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const correlationId = (req.headers['x-correlation-id'] as string) ?? 'unknown';

  if (err instanceof DomainError) {
    const statusMap: Record<string, number> = {
      NOT_FOUND: 404,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      CONFLICT: 409,
      VALIDATION_ERROR: 422,
      OPENAI_NOT_CONFIGURED: 503,
      OPENAI_EMPTY_RESPONSE: 502,
      BUILDERBOT_ERROR: 502,
      BUILDERBOT_NOT_CONFIGURED: 503,
      WEBHOOK_UNAUTHORIZED: 401,
      WEBHOOK_VERIFY_FAILED: 403,
    };

    const status = statusMap[err.code] ?? 400;

    logger.warn({ err, correlationId, code: err.code }, err.message);

    res.status(status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err instanceof ValidationError ? { details: err.details } : {}),
      },
    });
    return;
  }

  logger.error({ err, correlationId }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Error interno del servidor',
    },
  });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' },
  });
}
