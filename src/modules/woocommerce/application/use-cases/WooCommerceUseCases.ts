import { inject, injectable } from 'tsyringe';
import { TenantContext, UseCase } from '../../../../shared/application/UseCase';
import { ForbiddenError } from '../../../../shared/domain/errors/DomainError';
import { UserRole } from '../../../identity/domain/entities/User.types';
import {
  IWooCommerceConfigRepository,
  IWooCommerceService,
  WooCommerceConfigData,
} from '../../domain/IWooCommerceService';

function resolveTenantId(actor: TenantContext, explicit?: string): string {
  if (actor.role === UserRole.ADMIN && explicit) return explicit;
  if (actor.tenantId) return actor.tenantId;
  throw new ForbiddenError('Tenant requerido');
}

export interface WooCommerceConfigPublic {
  storeUrl: string;
  connected: boolean;
  lastSyncAt?: string;
  updatedAt: string;
  hasCredentials: boolean;
}

@injectable()
export class UpdateWooCommerceConfigUseCase
  implements
    UseCase<
      {
        actor: TenantContext;
        tenantId?: string;
        storeUrl: string;
        consumerKey: string;
        consumerSecret: string;
      },
      WooCommerceConfigPublic
    >
{
  constructor(@inject('IWooCommerceConfigRepository') private readonly configRepo: IWooCommerceConfigRepository) {}

  async execute(input: {
    actor: TenantContext;
    tenantId?: string;
    storeUrl: string;
    consumerKey: string;
    consumerSecret: string;
  }) {
    const tenantId = resolveTenantId(input.actor, input.tenantId);
    const now = new Date().toISOString();

    const config: WooCommerceConfigData = {
      tenantId,
      storeUrl: input.storeUrl.replace(/\/$/, ''),
      consumerKey: input.consumerKey,
      consumerSecret: input.consumerSecret,
      connected: false,
      updatedAt: now,
    };

    await this.configRepo.save(config);
    return this.toPublic(config);
  }

  private toPublic(config: WooCommerceConfigData): WooCommerceConfigPublic {
    return {
      storeUrl: config.storeUrl,
      connected: config.connected,
      lastSyncAt: config.lastSyncAt,
      updatedAt: config.updatedAt,
      hasCredentials: !!(config.consumerKey && config.consumerSecret),
    };
  }
}

@injectable()
export class GetWooCommerceConfigUseCase
  implements UseCase<{ actor: TenantContext; tenantId?: string }, WooCommerceConfigPublic | null>
{
  constructor(@inject('IWooCommerceConfigRepository') private readonly configRepo: IWooCommerceConfigRepository) {}

  async execute(input: { actor: TenantContext; tenantId?: string }) {
    const tenantId = resolveTenantId(input.actor, input.tenantId);
    const config = await this.configRepo.findByTenantId(tenantId);
    if (!config) return null;

    return {
      storeUrl: config.storeUrl,
      connected: config.connected,
      lastSyncAt: config.lastSyncAt,
      updatedAt: config.updatedAt,
      hasCredentials: !!(config.consumerKey && config.consumerSecret),
    };
  }
}

@injectable()
export class TestWooCommerceConnectionUseCase implements UseCase<{ actor: TenantContext; tenantId?: string }, { connected: boolean }> {
  constructor(
    @inject('IWooCommerceConfigRepository') private readonly configRepo: IWooCommerceConfigRepository,
    @inject('IWooCommerceService') private readonly wcService: IWooCommerceService
  ) {}

  async execute(input: { actor: TenantContext; tenantId?: string }) {
    const tenantId = resolveTenantId(input.actor, input.tenantId);
    const config = await this.configRepo.findByTenantId(tenantId);
    if (!config) throw new ForbiddenError('WooCommerce no configurado');

    await this.wcService.testConnection(config);

    await this.configRepo.save({
      ...config,
      connected: true,
      lastSyncAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return { connected: true };
  }
}

@injectable()
export class ListWooCommerceProductsUseCase {
  constructor(
    @inject('IWooCommerceConfigRepository') private readonly configRepo: IWooCommerceConfigRepository,
    @inject('IWooCommerceService') private readonly wcService: IWooCommerceService
  ) {}

  async execute(input: { actor: TenantContext; tenantId?: string; page?: number }) {
    const tenantId = resolveTenantId(input.actor, input.tenantId);
    const config = await this.configRepo.findByTenantId(tenantId);
    if (!config) throw new ForbiddenError('WooCommerce no configurado');

    return this.wcService.listProducts(config, input.page);
  }
}

@injectable()
export class GetWooCommerceStockUseCase {
  constructor(
    @inject('IWooCommerceConfigRepository') private readonly configRepo: IWooCommerceConfigRepository,
    @inject('IWooCommerceService') private readonly wcService: IWooCommerceService
  ) {}

  async execute(input: { tenantId: string; sku: string }) {
    const config = await this.configRepo.findByTenantId(input.tenantId);
    if (!config) throw new ForbiddenError('WooCommerce no configurado');

    const product = await this.wcService.getProductBySku(config, input.sku);
    if (!product) return null;

    return {
      sku: product.sku,
      name: product.name,
      stockQuantity: product.stockQuantity,
      stockStatus: product.stockStatus,
      price: product.price,
      inStock: product.stockStatus === 'instock',
    };
  }
}
