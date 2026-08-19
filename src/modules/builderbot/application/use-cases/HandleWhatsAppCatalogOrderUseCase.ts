import { inject, injectable } from 'tsyringe';
import { UseCase } from '../../../../shared/application/UseCase';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../../../../shared/domain/errors/DomainError';
import { env } from '../../../../shared/infrastructure/config/env';
import { AuditService } from '../../../../shared/infrastructure/audit/AuditService';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { BusinessStatus } from '../../../tenant/domain/entities/Business.types';
import { IBusinessRepository } from '../../../tenant/domain/repositories/IBusinessRepository';
import { SalesAgentService } from '../../../sales-agent/application/services/SalesAgentService';
import { BbcWebhookAgentResponse, emptyBbcWebhookResponse } from '../../domain/BbcWebhookAgentResponse';
import { IBuilderBotConfigRepository } from '../../domain/IBuilderBotCloudService';
import { parseWhatsAppCatalogOrder } from '../../domain/whatsappCatalogOrder.utils';
import { isSalesAgentEnabled } from '../../domain/salesAgentEnabled.utils';

const WEBHOOK_ACTOR = 'system:builderbot-order-webhook';

@injectable()
export class HandleWhatsAppCatalogOrderUseCase
  implements
    UseCase<
      { tenantId: string; payload: unknown; headers: Record<string, string | undefined> },
      { received: boolean; bbcResponse: BbcWebhookAgentResponse; addedCount: number }
    >
{
  constructor(
    @inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository,
    @inject('IBuilderBotConfigRepository') private readonly builderBotConfigRepo: IBuilderBotConfigRepository,
    @inject(AuditService) private readonly audit: AuditService,
    @inject(SalesAgentService) private readonly salesAgent: SalesAgentService
  ) {}

  async execute(input: {
    tenantId: string;
    payload: unknown;
    headers: Record<string, string | undefined>;
  }): Promise<{ received: boolean; bbcResponse: BbcWebhookAgentResponse; addedCount: number }> {
    this.assertWebhookSecret(input.headers);

    const business = await this.businessRepo.findById(input.tenantId);
    if (!business) throw new NotFoundError('Negocio no encontrado');
    if (business.status !== BusinessStatus.ACTIVE) {
      throw new ForbiddenError('El negocio no está activo');
    }

    const config = await this.builderBotConfigRepo.findByTenantId(input.tenantId);
    if (!config) throw new NotFoundError('WhatsApp no provisionado para este negocio');

    const order = parseWhatsAppCatalogOrder(input.payload);
    logger.info(
      {
        tenantId: input.tenantId,
        payload: input.payload,
        parsedProducts: order?.products ?? [],
        from: order?.from,
      },
      'BuilderBot pedido catálogo WhatsApp recibido'
    );

    if (!order) {
      await this.audit.log({
        tenantId: input.tenantId,
        userId: WEBHOOK_ACTOR,
        action: 'BUILDERBOT_CATALOG_ORDER_INVALID',
        resource: 'builderbot_order_webhook',
        metadata: { payloadKeys: payloadKeys(input.payload) },
      });
      return { received: true, bbcResponse: emptyBbcWebhookResponse(), addedCount: 0 };
    }

    if (!isSalesAgentEnabled(config)) {
      logger.info(
        { tenantId: input.tenantId, from: order.from },
        'Pedido catálogo WhatsApp ignorado: agente desactivado'
      );
      return { received: true, bbcResponse: emptyBbcWebhookResponse(), addedCount: 0 };
    }

    await this.audit.log({
      tenantId: input.tenantId,
      userId: WEBHOOK_ACTOR,
      action: 'BUILDERBOT_CATALOG_ORDER_RECEIVED',
      resource: 'builderbot_order_webhook',
      resourceId: order.from,
      metadata: {
        from: order.from,
        productCount: order.products.length,
        retailerIds: order.products.map((p) => p.retailerId),
        catalogId: order.catalogId,
      },
    });

    const result = await this.salesAgent.handleWhatsAppCatalogOrder({
      tenantId: input.tenantId,
      deviceId: config.deviceId,
      customerPhone: order.from,
      customerName: order.name,
      products: order.products,
    });

    return {
      received: true,
      bbcResponse: result.bbcResponse ?? emptyBbcWebhookResponse(),
      addedCount: order.products.length,
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
}

function payloadKeys(payload: unknown): string[] {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload as Record<string, unknown>)
    : [];
}
