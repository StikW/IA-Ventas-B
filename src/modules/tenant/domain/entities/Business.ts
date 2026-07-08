import { Entity } from '../../../../shared/domain/Entity';
import { BusinessProps, BusinessStatus } from './Business.types';

export class Business extends Entity<BusinessProps> {
  private constructor(props: BusinessProps, id: string) {
    super(props, id);
  }

  static create(props: BusinessProps, id: string): Business {
    return new Business(props, id);
  }

  get name(): string {
    return this.props.name;
  }

  get slug(): string {
    return this.props.slug;
  }

  get status(): BusinessStatus {
    return this.props.status;
  }

  get contactEmail(): string {
    return this.props.contactEmail;
  }

  get contactPhone(): string | undefined {
    return this.props.contactPhone;
  }

  get createdBy(): string {
    return this.props.createdBy;
  }

  get createdAt(): string {
    return this.props.createdAt;
  }

  get updatedAt(): string {
    return this.props.updatedAt;
  }

  isActive(): boolean {
    return this.props.status === BusinessStatus.ACTIVE;
  }

  activate(): Business {
    return Business.create({ ...this.props, status: BusinessStatus.ACTIVE, updatedAt: new Date().toISOString() }, this.id);
  }

  deactivate(): Business {
    return Business.create({ ...this.props, status: BusinessStatus.INACTIVE, updatedAt: new Date().toISOString() }, this.id);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      slug: this.slug,
      status: this.status,
      contactEmail: this.contactEmail,
      contactPhone: this.contactPhone,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
