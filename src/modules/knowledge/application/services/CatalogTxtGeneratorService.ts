import { inject, injectable } from 'tsyringe';
import { DomainError } from '../../../../shared/domain/errors/DomainError';
import {
  IWooCommerceConfigRepository,
  IWooCommerceService,
} from '../../../woocommerce/domain/IWooCommerceService';
import {
  buildCatalogTxt,
  summarizeCatalogIssues,
  type CatalogTxtResult,
} from './catalogTxt.builder';

export interface GeneratedCatalogTxt extends CatalogTxtResult {
  issueSummary: Array<{ kind: string; count: number }>;
}

@injectable()
export class CatalogTxtGeneratorService {
  constructor(
    @inject('IWooCommerceConfigRepository') private readonly wcConfigRepo: IWooCommerceConfigRepository,
    @inject('IWooCommerceService') private readonly wcService: IWooCommerceService
  ) {}

  async generateForTenant(tenantId: string): Promise<GeneratedCatalogTxt> {
    const config = await this.wcConfigRepo.findByTenantId(tenantId);
    if (!config?.storeUrl?.trim() || !config.consumerKey?.trim() || !config.consumerSecret?.trim()) {
      throw new DomainError(
        'Configura WooCommerce en el panel antes de actualizar el catálogo.',
        'WOOCOMMERCE_NOT_CONFIGURED'
      );
    }

    const entries = await this.wcService.listCatalogTxtSource(config);
    const result = buildCatalogTxt(entries);

    if (!result.stats.productCount) {
      throw new DomainError(
        'WooCommerce no devolvió productos publicados con SKU. Revisa el catálogo de la tienda.',
        'CATALOG_EMPTY'
      );
    }

    return {
      ...result,
      issueSummary: summarizeCatalogIssues(result.issues),
    };
  }
}
