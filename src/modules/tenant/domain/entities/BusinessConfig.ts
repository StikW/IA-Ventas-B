import { Entity } from '../../../../shared/domain/Entity';
import { BusinessConfigProps, BusinessProfileConfig } from './Config.types';

export class BusinessConfig extends Entity<BusinessConfigProps> {
  private constructor(props: BusinessConfigProps, id: string) {
    super(props, id);
  }

  static create(props: BusinessConfigProps, id: string): BusinessConfig {
    return new BusinessConfig(props, id);
  }

  static defaultForTenant(tenantId: string): BusinessConfig {
    const now = new Date().toISOString();
    return BusinessConfig.create(
      {
        tenantId,
        business: {},
        createdAt: now,
        updatedAt: now,
      },
      tenantId
    );
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get business(): BusinessProfileConfig {
    return this.props.business;
  }

  get updatedAt(): string {
    return this.props.updatedAt;
  }

  updateBusiness(profile: Partial<BusinessProfileConfig>): BusinessConfig {
    return BusinessConfig.create(
      {
        ...this.props,
        business: { ...this.props.business, ...profile },
        updatedAt: new Date().toISOString(),
      },
      this.id
    );
  }

  toJSON() {
    return {
      tenantId: this.tenantId,
      business: this.business,
      createdAt: this.props.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
