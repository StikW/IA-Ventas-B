import { inject, injectable } from 'tsyringe';
import { UseCase } from '../../../../shared/application/UseCase';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../../../../shared/domain/errors/DomainError';
import { env } from '../../../../shared/infrastructure/config/env';
import { AuditService } from '../../../../shared/infrastructure/audit/AuditService';
import { isBuilderBotTemplateLiteral } from '../../infrastructure/builderBotPhone';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { BusinessStatus } from '../../../tenant/domain/entities/Business.types';
import { IBusinessRepository } from '../../../tenant/domain/repositories/IBusinessRepository';
import { BuilderBotWebhookEvent, BuilderBotWebhookResult } from '../../domain/BuilderBotWebhook.types';
import { IBuilderBotConfigRepository } from '../../domain/IBuilderBotCloudService';
import { BuilderBotWebhookParser } from '../services/BuilderBotWebhookParser';

const WEBHOOK_ACTOR = 'system:builderbot-webhook';

function payloadKeys(payload: unknown): string[] {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload as Record<string, unknown>)
    : [];
}

function auditActionFor(event: BuilderBotWebhookEvent): string {
  switch (event.type) {
    case 'message.incoming':
      return 'BUILDERBOT_MESSAGE_RECEIVED';
    case 'message.status':
      return 'BUILDERBOT_MESSAGE_STATUS';
    case 'session.update':
      return 'BUILDERBOT_SESSION_UPDATE';
    default:
      return 'BUILDERBOT_WEBHOOK_RECEIVED';
  }
}

@injectable()
export class HandleBuilderBotWebhookUseCase
  implements UseCase<{ tenantId: string; payload: unknown; headers: Record<string, string | undefined> }, BuilderBotWebhookResult>
{
  constructor(
    @inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository,
    @inject('IBuilderBotConfigRepository') private readonly builderBotConfigRepo: IBuilderBotConfigRepository,
    @inject(AuditService) private readonly audit: AuditService,
    private readonly parser: BuilderBotWebhookParser
  ) {}

  async execute(input: {
    tenantId: string;
    payload: unknown;
    headers: Record<string, string | undefined>;
  }): Promise<BuilderBotWebhookResult> {
    this.assertWebhookSecret(input.headers);

    const business = await this.businessRepo.findById(input.tenantId);
    if (!business) throw new NotFoundError('Negocio no encontrado');
    if (business.status !== BusinessStatus.ACTIVE) {
      throw new ForbiddenError('El negocio no está activo');
    }

    const config = await this.builderBotConfigRepo.findByTenantId(input.tenantId);
    if (!config) throw new NotFoundError('WhatsApp no provisionado para este negocio');

    const events = this.parser.parse(input.payload);
    this.assertDeviceMatches(events, config.deviceId);

    await Promise.all(
      events.map((event) =>
        this.audit.log({
          tenantId: input.tenantId,
          userId: WEBHOOK_ACTOR,
          action: auditActionFor(event),
          resource: 'builderbot_webhook',
          resourceId: event.messageId ?? event.deviceId,
          metadata: {
            type: event.type,
            from: event.from,
            messageType: event.messageType,
            textPreview: event.text ? event.text.slice(0, 120) : undefined,
            status: event.status,
            sessionStatus: event.sessionStatus,
            timestamp: event.timestamp,
          },
        })
      )
    );

    const incomingCount = events.filter((e) => e.type === 'message.incoming').length;
    const logPayload = {
      tenantId: input.tenantId,
      payloadKeys: payloadKeys(input.payload),
      eventsProcessed: events.length,
      eventTypes: events.map((event) => event.type),
      incomingCount,
    };

    if (incomingCount === 0 && events.some((event) => event.type === 'unknown')) {
      logger.warn(
        {
          ...logPayload,
          payloadSample: JSON.stringify(input.payload).slice(0, 500),
        },
        'BuilderBot webhook sin mensajes reconocidos'
      );
    } else {
      logger.info(logPayload, 'BuilderBot webhook procesado');
    }

    return {
      received: true,
      tenantId: input.tenantId,
      deviceId: config.deviceId,
      eventsProcessed: events.length,
      events: events.map((event) => ({
        type: event.type,
        messageId: event.messageId,
        from: event.from,
      })),
      incomingMessages: events
        .filter(
          (event) =>
            event.type === 'message.incoming' &&
            !!event.from &&
            !!event.text?.trim() &&
            !isBuilderBotTemplateLiteral(event.from) &&
            !isBuilderBotTemplateLiteral(event.text) &&
            (!event.messageType || event.messageType === 'text')
        )
        .map((event) => ({
          from: event.from!,
          text: event.text!,
          messageId: event.messageId,
          messageType: event.messageType,
        })),
      incomingImages: events
        .filter(
          (event) =>
            event.type === 'message.incoming' &&
            !!event.from &&
            (!!event.mediaUrl || ['image', 'document'].includes(String(event.messageType ?? '').toLowerCase()))
        )
        .map((event) => ({
          from: event.from!,
          messageId: event.messageId,
          messageType: event.messageType,
          mediaUrl: event.mediaUrl,
          caption: event.caption,
        })),
    };
  }

  private assertWebhookSecret(headers: Record<string, string | undefined>): void {
    const secret = env.BUILDERBOT_WEBHOOK_SECRET;
    if (!secret) return;

    const headerSecret = headers['x-webhook-secret'];
    const authHeader = headers.authorization;
    const bearerSecret = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    if (headerSecret === secret || bearerSecret === secret) return;
    throw new UnauthorizedError('Webhook no autorizado', 'WEBHOOK_UNAUTHORIZED');
  }

  private assertDeviceMatches(events: BuilderBotWebhookEvent[], expectedDeviceId: string): void {
    const payloadDeviceId = events.find((event) => event.deviceId)?.deviceId;
    if (payloadDeviceId && payloadDeviceId !== expectedDeviceId) {
      throw new ForbiddenError('El device del webhook no coincide con el negocio');
    }
  }
}
