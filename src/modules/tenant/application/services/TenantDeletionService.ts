import { inject, injectable } from 'tsyringe';
import { NotFoundError } from '../../../../shared/domain/errors/DomainError';
import { hasBuilderBot } from '../../../../shared/infrastructure/config/env';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { IBuilderBotCloudService, IBuilderBotConfigRepository } from '../../../builderbot/domain/IBuilderBotCloudService';
import { IStorageService, IVectorStore } from '../../../knowledge/domain/ports/KnowledgePorts';
import { IDocumentRepository } from '../../../knowledge/domain/repositories/IDocumentRepository';
import { IOrderRepository } from '../../../commerce/domain/repositories/IOrderRepository';
import { IBusinessRepository } from '../../domain/repositories/IBusinessRepository';
import { PlatformTenantCleanupService } from '../../infrastructure/persistence/PlatformTenantCleanupService';

export interface TenantDeletionSummary {
  tenantId: string;
  businessName: string;
  documents: number;
  orders: number;
  users: number;
  storageFiles: number;
  vectorsCleared: boolean;
  builderBotDeviceDeleted: boolean;
  dynamoRecords: number;
  auditLogs: number;
  warnings: string[];
}

@injectable()
export class TenantDeletionService {
  constructor(
    @inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository,
    @inject('IDocumentRepository') private readonly documentRepo: IDocumentRepository,
    @inject('IOrderRepository') private readonly orderRepo: IOrderRepository,
    @inject('IBuilderBotConfigRepository') private readonly builderBotConfigRepo: IBuilderBotConfigRepository,
    @inject('IBuilderBotCloudService') private readonly builderBot: IBuilderBotCloudService,
    @inject('IStorageService') private readonly storage: IStorageService,
    @inject('IVectorStore') private readonly vectorStore: IVectorStore,
    @inject(PlatformTenantCleanupService) private readonly platformCleanup: PlatformTenantCleanupService
  ) {}

  async deleteTenant(tenantId: string): Promise<TenantDeletionSummary> {
    const business = await this.businessRepo.findById(tenantId);
    if (!business) {
      throw new NotFoundError('Negocio no encontrado');
    }

    const warnings: string[] = [];
    const [documents, orders] = await Promise.all([
      this.countAll((cursor) => this.documentRepo.findByTenant(tenantId, { limit: 100, cursor })),
      this.countAll((cursor) => this.orderRepo.findByTenant(tenantId, { limit: 100, cursor })),
    ]);

    const bbConfig = await this.builderBotConfigRepo.findByTenantId(tenantId);
    let builderBotDeviceDeleted = false;

    if (bbConfig?.deviceId && hasBuilderBot) {
      try {
        await this.builderBot.deleteDevice(bbConfig.deviceId);
        builderBotDeviceDeleted = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error eliminando device BuilderBot';
        warnings.push(message);
        logger.warn({ err, tenantId, deviceId: bbConfig.deviceId }, 'No se pudo eliminar device BuilderBot');
      }
    }

    let storageFiles = 0;
    try {
      storageFiles = await this.storage.deleteTenantFiles(tenantId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error eliminando archivos del tenant';
      warnings.push(message);
      logger.warn({ err, tenantId }, 'No se pudieron eliminar todos los archivos del tenant');
    }

    let vectorsCleared = false;
    try {
      await this.vectorStore.deleteNamespace(tenantId);
      vectorsCleared = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error eliminando vectores del tenant';
      warnings.push(message);
      logger.warn({ err, tenantId }, 'No se pudieron eliminar vectores del tenant');
    }

    const cleanup = await this.platformCleanup.deleteTenantData(tenantId);

    logger.info(
      {
        tenantId,
        businessName: business.name,
        documents,
        orders,
        users: cleanup.userIds.length,
        storageFiles,
        builderBotDeviceDeleted,
        dynamoRecords: cleanup.dynamoRecords,
        auditLogs: cleanup.auditLogs,
        warnings,
      },
      'Negocio eliminado completamente'
    );

    return {
      tenantId,
      businessName: business.name,
      documents,
      orders,
      users: cleanup.userIds.length,
      storageFiles,
      vectorsCleared,
      builderBotDeviceDeleted,
      dynamoRecords: cleanup.dynamoRecords,
      auditLogs: cleanup.auditLogs,
      warnings,
    };
  }

  private async countAll<T extends { hasMore?: boolean; cursor?: string }>(
    fetchPage: (cursor?: string) => Promise<{ data: unknown[]; hasMore?: boolean; cursor?: string }>
  ): Promise<number> {
    let total = 0;
    let cursor: string | undefined;

    do {
      const page = await fetchPage(cursor);
      total += page.data.length;
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    return total;
  }
}
