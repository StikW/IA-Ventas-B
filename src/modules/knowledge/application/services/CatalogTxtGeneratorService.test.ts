import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../../../shared/domain/errors/DomainError';
import {
  IWooCommerceConfigRepository,
  IWooCommerceService,
} from '../../../woocommerce/domain/IWooCommerceService';
import { CatalogTxtGeneratorService } from './CatalogTxtGeneratorService';

describe('CatalogTxtGeneratorService', () => {
  it('falla si el negocio no tiene WooCommerce configurado', async () => {
    const wcConfigRepo = {
      findByTenantId: vi.fn().mockResolvedValue(null),
    } as unknown as IWooCommerceConfigRepository;
    const wcService = { listCatalogTxtSource: vi.fn() } as unknown as IWooCommerceService;

    const service = new CatalogTxtGeneratorService(wcConfigRepo, wcService);

    await expect(service.generateForTenant('tenant-1')).rejects.toBeInstanceOf(DomainError);
    await expect(service.generateForTenant('tenant-1')).rejects.toThrow(
      'Configura WooCommerce en el panel'
    );
    expect(wcService.listCatalogTxtSource).not.toHaveBeenCalled();
  });

  it('falla si la tienda no tiene productos vendibles', async () => {
    const wcConfigRepo = {
      findByTenantId: vi.fn().mockResolvedValue({
        storeUrl: 'https://tienda.test',
        consumerKey: 'ck',
        consumerSecret: 'cs',
      }),
    } as unknown as IWooCommerceConfigRepository;
    const wcService = {
      listCatalogTxtSource: vi.fn().mockResolvedValue([
        {
          product: {
            id: 1,
            name: 'Sin sku',
            sku: '',
            type: 'simple',
            status: 'publish',
            price: '0',
            short_description: '',
            stock_status: 'outofstock',
            categories: [],
            tags: [],
            attributes: [],
            meta_data: [],
          },
          variations: [],
        },
      ]),
    } as unknown as IWooCommerceService;

    const service = new CatalogTxtGeneratorService(wcConfigRepo, wcService);

    await expect(service.generateForTenant('tenant-1')).rejects.toThrow(
      'WooCommerce no devolvió productos publicados con SKU'
    );
  });
});
