import { Order } from '../entities/Order';
import { PaginatedResult, PaginationInput } from '../../../../shared/application/UseCase';

export interface IOrderRepository {
  findById(tenantId: string, id: string): Promise<Order | null>;
  findByTenant(tenantId: string, pagination: PaginationInput, status?: string): Promise<PaginatedResult<Order>>;
  save(order: Order): Promise<void>;
  update(order: Order): Promise<void>;
}
