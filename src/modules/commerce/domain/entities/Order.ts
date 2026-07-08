import { Entity } from '../../../../shared/domain/Entity';
import { OrderProps, OrderStatus } from './Order.types';

export class Order extends Entity<OrderProps> {
  private constructor(props: OrderProps, id: string) {
    super(props, id);
  }

  static create(props: OrderProps, id: string): Order {
    return new Order(props, id);
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get status(): OrderStatus {
    return this.props.status;
  }

  toJSON() {
    return {
      id: this.id,
      tenantId: this.tenantId,
      customerPhone: this.props.customerPhone,
      customerName: this.props.customerName,
      items: this.props.items,
      total: this.props.total,
      currency: this.props.currency,
      status: this.status,
      woocommerceOrderId: this.props.woocommerceOrderId,
      woocommerceOrderNumber: this.props.woocommerceOrderNumber,
      notes: this.props.notes,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    };
  }
}
