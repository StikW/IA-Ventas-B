import { inject, injectable } from 'tsyringe';
import { TenantContext, UseCase } from '../../../../shared/application/UseCase';
import { ForbiddenError } from '../../../../shared/domain/errors/DomainError';
import { UserRole } from '../../../identity/domain/entities/User.types';
import {
  IWooCommerceConfigRepository,
  IWooCommerceService,
  WooCommerceConfigData,
} from '../../domain/IWooCommerceService';
import { IMassiBotService } from '../../../massi-bot/domain/IMassiBotService';

function resolveTenantId(actor: TenantContext, explicit?: string): string {
  if (actor.role === UserRole.ADMIN && explicit) return explicit;
  if (actor.tenantId) return actor.tenantId;
  throw new ForbiddenError('Tenant requerido');
}

export interface WooCommerceConfigPublic {
  storeUrl: string;
  connected: boolean;
  botApiConnected: boolean;
  lastSyncAt?: string;
  updatedAt: string;
  hasCredentials: boolean;
  hasBotApiCredentials: boolean;
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
        botApiUser?: string;
        botApiPassword?: string;
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
    botApiUser?: string;
    botApiPassword?: string;
  }) {
    const tenantId = resolveTenantId(input.actor, input.tenantId);
    const now = new Date().toISOString();
    const existing = await this.configRepo.findByTenantId(tenantId);

    const consumerKey = input.consumerKey.trim() || existing?.consumerKey || '';
    const consumerSecret = input.consumerSecret.trim() || existing?.consumerSecret || '';
    const botApiUser = input.botApiUser?.trim() || existing?.botApiUser || '';
    const botApiPassword = (input.botApiPassword?.replace(/\s+/g, '') || existing?.botApiPassword || '').trim();

    const config: WooCommerceConfigData = {
      tenantId,
      storeUrl: input.storeUrl.replace(/\/$/, ''),
      consumerKey,
      consumerSecret,
      botApiUser: botApiUser || undefined,
      botApiPassword: botApiPassword || undefined,
      connected: false,
      botApiConnected: false,
      updatedAt: now,
    };

    await this.configRepo.save(config);
    return this.toPublic(config);
  }

  private toPublic(config: WooCommerceConfigData): WooCommerceConfigPublic {
    return {
      storeUrl: config.storeUrl,
      connected: config.connected,
      botApiConnected: !!config.botApiConnected,
      lastSyncAt: config.lastSyncAt,
      updatedAt: config.updatedAt,
      hasCredentials: !!(config.consumerKey && config.consumerSecret),
      hasBotApiCredentials: !!(config.botApiUser && config.botApiPassword),
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
      botApiConnected: !!config.botApiConnected,
      lastSyncAt: config.lastSyncAt,
      updatedAt: config.updatedAt,
      hasCredentials: !!(config.consumerKey && config.consumerSecret),
      hasBotApiCredentials: !!(config.botApiUser && config.botApiPassword),
    };
  }
}

@injectable()
export class TestWooCommerceConnectionUseCase
  implements
    UseCase<
      { actor: TenantContext; tenantId?: string; botApiUser?: string; botApiPassword?: string },
      { connected: boolean; botApiConnected: boolean; botApiStatus: string; botApiDetail?: string }
    >
{
  constructor(
    @inject('IWooCommerceConfigRepository') private readonly configRepo: IWooCommerceConfigRepository,
    @inject('IWooCommerceService') private readonly wcService: IWooCommerceService,
    @inject('IMassiBotService') private readonly massiBot: IMassiBotService
  ) {}

  async execute(input: {
    actor: TenantContext;
    tenantId?: string;
    botApiUser?: string;
    botApiPassword?: string;
  }) {
    const tenantId = resolveTenantId(input.actor, input.tenantId);
    const config = await this.configRepo.findByTenantId(tenantId);
    if (!config) throw new ForbiddenError('WooCommerce no configurado');

    const { checkoutPagePath } = await this.wcService.testConnection(config);

    const botConfig: WooCommerceConfigData = {
      ...config,
      botApiUser: input.botApiUser?.trim() || config.botApiUser,
      botApiPassword: input.botApiPassword?.replace(/\s+/g, '') || config.botApiPassword,
    };

    let botApiConnected = false;
    let botApiStatus: 'connected' | 'missing_credentials' | 'auth_failed' | 'forbidden' = 'missing_credentials';
    let botApiDetail: string | undefined;

    if (this.massiBot.isConfigured(botConfig)) {
      try {
        await this.massiBot.ping(botConfig);
        botApiConnected = true;
        botApiStatus = 'connected';
        await this.configRepo.save({
          ...config,
          botApiUser: botConfig.botApiUser,
          botApiPassword: botConfig.botApiPassword,
          checkoutPagePath: checkoutPagePath ?? config.checkoutPagePath,
          connected: true,
          botApiConnected: true,
          lastSyncAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return { connected: true, botApiConnected: true, botApiStatus };
      } catch (err) {
        botApiDetail = err instanceof Error ? err.message : String(err);
        botApiStatus = botApiDetail.includes('rest_forbidden') ? 'forbidden' : 'auth_failed';
      }
    }

    const now = new Date().toISOString();
    await this.configRepo.save({
      ...config,
      checkoutPagePath: checkoutPagePath ?? config.checkoutPagePath,
      connected: true,
      botApiConnected,
      lastSyncAt: now,
      updatedAt: now,
    });

    return { connected: true, botApiConnected, botApiStatus, botApiDetail };
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
