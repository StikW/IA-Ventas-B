import { inject, injectable } from 'tsyringe';
import { TenantContext, UseCase } from '../../../../shared/application/UseCase';
import { ForbiddenError, NotFoundError } from '../../../../shared/domain/errors/DomainError';
import { generateId } from '../../../../shared/infrastructure/utils/crypto.utils';
import { AuditService } from '../../../../shared/infrastructure/audit/AuditService';
import { Order } from '../../domain/entities/Order';
import { OrderItem, OrderStatus } from '../../domain/entities/Order.types';
import { IOrderRepository } from '../../domain/repositories/IOrderRepository';
import { IDocumentRepository } from '../../../knowledge/domain/repositories/IDocumentRepository';
import { IWooCommerceConfigRepository, IWooCommerceService } from '../../../woocommerce/domain/IWooCommerceService';
import { OrderNotificationService } from '../services/OrderNotificationService';
import { DomainError } from '../../../../shared/domain/errors/DomainError';

function resolveTenantId(actor: TenantContext): string {
  if (actor.tenantId) return actor.tenantId;
  throw new ForbiddenError('Tenant requerido');
}

@injectable()
export class CreateOrderUseCase {
  constructor(
    @inject('IOrderRepository') private readonly orderRepo: IOrderRepository,
    @inject('IWooCommerceConfigRepository') private readonly wcConfigRepo: IWooCommerceConfigRepository,
    @inject('IWooCommerceService') private readonly wcService: IWooCommerceService,
    @inject(AuditService) private readonly audit: AuditService
  ) {}

  async execute(input: {
    tenantId: string;
    customerPhone: string;
    customerName: string;
    items: OrderItem[];
    notes?: string;
    syncWooCommerce?: boolean;
    actorUserId?: string;
  }) {
    const now = new Date().toISOString();
    const total = input.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    const id = generateId();

    let status = OrderStatus.PENDING;
    let woocommerceOrderId: string | undefined;
    let woocommerceOrderNumber: string | undefined;

    if (input.syncWooCommerce !== false) {
      const wcConfig = await this.wcConfigRepo.findByTenantId(input.tenantId);
      if (wcConfig?.connected) {
        const wcOrder = await this.wcService.createOrder(wcConfig, {
          paymentMethod: 'bacs',
          paymentMethodTitle: 'Transferencia bancaria',
          setPaid: false,
          billing: { firstName: input.customerName, phone: input.customerPhone },
          lineItems: input.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        });
        status = OrderStatus.AWAITING_PAYMENT;
        woocommerceOrderId = String(wcOrder.id);
        woocommerceOrderNumber = wcOrder.number;
      }
    }

    const order = Order.create(
      {
        tenantId: input.tenantId,
        customerPhone: input.customerPhone,
        customerName: input.customerName,
        items: input.items,
        total,
        currency: 'COP',
        status,
        woocommerceOrderId,
        woocommerceOrderNumber,
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      },
      id
    );

    await this.orderRepo.save(order);

    if (input.actorUserId) {
      await this.audit.log({
        tenantId: input.tenantId,
        userId: input.actorUserId,
        action: 'ORDER_CREATED',
        resource: 'order',
        resourceId: order.id,
        metadata: { total, customerPhone: input.customerPhone },
      });
    }

    return order.toJSON();
  }
}

@injectable()
export class UpdateOrderStatusUseCase {
  constructor(
    @inject('IOrderRepository') private readonly orderRepo: IOrderRepository,
    @inject('IWooCommerceConfigRepository') private readonly wcConfigRepo: IWooCommerceConfigRepository,
    @inject('IWooCommerceService') private readonly wcService: IWooCommerceService,
    @inject(OrderNotificationService) private readonly notifications: OrderNotificationService,
    @inject(AuditService) private readonly audit: AuditService
  ) {}

  async execute(input: {
    actor: TenantContext;
    orderId: string;
    status: OrderStatus;
  }) {
    const tenantId = resolveTenantId(input.actor);
    const order = await this.orderRepo.findById(tenantId, input.orderId);
    if (!order) throw new NotFoundError('Pedido no encontrado');

    const previousStatus = order.status;
    if (previousStatus === input.status) {
      return order.toJSON();
    }

    if (input.status === OrderStatus.PAID && previousStatus !== OrderStatus.AWAITING_PAYMENT) {
      throw new DomainError(
        'Solo se puede marcar como pagado un pedido en AWAITING_PAYMENT',
        'INVALID_ORDER_STATUS_TRANSITION'
      );
    }

    order.updateStatus(input.status);

    if (input.status === OrderStatus.PAID) {
      const wcConfig = await this.wcConfigRepo.findByTenantId(tenantId);
      const wcOrderId = order.toJSON().woocommerceOrderId;
      if (wcConfig?.connected && wcOrderId) {
        await this.wcService.updateOrder(wcConfig, Number(wcOrderId), {
          setPaid: true,
          status: 'processing',
        });
      }
      await this.notifications.notifyPaymentApproved(order);
    }

    await this.orderRepo.update(order);

    await this.audit.log({
      tenantId,
      userId: input.actor.userId,
      action: 'ORDER_STATUS_UPDATED',
      resource: 'order',
      resourceId: order.id,
      metadata: { from: previousStatus, to: input.status },
    });

    return order.toJSON();
  }
}

@injectable()
export class ListOrdersUseCase {
  constructor(@inject('IOrderRepository') private readonly orderRepo: IOrderRepository) {}

  async execute(input: { actor: TenantContext; status?: string; limit?: number; cursor?: string }) {
    const tenantId = resolveTenantId(input.actor);
    const result = await this.orderRepo.findByTenant(
      tenantId,
      { limit: input.limit, cursor: input.cursor },
      input.status
    );
    return { ...result, data: result.data.map((o) => o.toJSON()) };
  }
}

@injectable()
export class GetOrderUseCase implements UseCase<{ actor: TenantContext; id: string }, ReturnType<Order['toJSON']>> {
  constructor(@inject('IOrderRepository') private readonly orderRepo: IOrderRepository) {}

  async execute(input: { actor: TenantContext; id: string }) {
    const tenantId = resolveTenantId(input.actor);
    const order = await this.orderRepo.findById(tenantId, input.id);
    if (!order) throw new NotFoundError('Pedido no encontrado');
    return order.toJSON();
  }
}

@injectable()
export class GetTenantMetricsUseCase {
  constructor(
    @inject('IOrderRepository') private readonly orderRepo: IOrderRepository,
    @inject('IDocumentRepository') private readonly documentRepo: IDocumentRepository,
    @inject(AuditService) private readonly audit: AuditService
  ) {}

  async execute(input: { actor: TenantContext }) {
    const tenantId = resolveTenantId(input.actor);
    const [orders, documents, auditLogs] = await Promise.all([
      this.orderRepo.findByTenant(tenantId, { limit: 100 }),
      this.documentRepo.findByTenant(tenantId, { limit: 100 }),
      this.audit.listByTenant(tenantId, 20),
    ]);

    return {
      ordersCount: orders.data.length,
      documentsCount: documents.data.length,
      documentsReady: documents.data.filter((d) => d.status === 'READY').length,
      recentOrders: orders.data.slice(0, 5).map((o) => o.toJSON()),
      recentAudit: auditLogs,
    };
  }
}
