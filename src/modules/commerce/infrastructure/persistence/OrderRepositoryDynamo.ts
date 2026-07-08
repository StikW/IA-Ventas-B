import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { injectable } from 'tsyringe';
import { dynamoDb, TABLE_NAME } from '../../../../shared/infrastructure/persistence/DynamoDbClient';
import { Order } from '../../domain/entities/Order';
import { OrderStatus } from '../../domain/entities/Order.types';
import { IOrderRepository } from '../../domain/repositories/IOrderRepository';
import { PaginatedResult, PaginationInput } from '../../../../shared/application/UseCase';

@injectable()
export class OrderRepositoryDynamo implements IOrderRepository {
  private toEntity(item: Record<string, unknown>): Order {
    return Order.create(item as Order['toJSON'] extends infer T ? never : never, item.id as string);
  }

  private toItem(order: Order) {
    const json = order.toJSON();
    return {
      PK: `TENANT#${order.tenantId}#ORDER#${order.id}`,
      SK: 'METADATA',
      GSI1PK: `TENANT#${order.tenantId}#ORDERS`,
      GSI1SK: `ORDER#${json.status}#${json.createdAt}#${order.id}`,
      entityType: 'ORDER',
      ...json,
    };
  }

  async findById(tenantId: string, id: string): Promise<Order | null> {
    const result = await dynamoDb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantId}#ORDER#${id}`, SK: 'METADATA' },
      })
    );
    if (!result.Item) return null;
    return Order.create(
      {
        tenantId: result.Item.tenantId as string,
        customerPhone: result.Item.customerPhone as string,
        customerName: result.Item.customerName as string,
        items: result.Item.items as Order['toJSON'] extends never ? never : import('../../domain/entities/Order.types').OrderItem[],
        total: result.Item.total as number,
        currency: result.Item.currency as string,
        status: result.Item.status as OrderStatus,
        woocommerceOrderId: result.Item.woocommerceOrderId as string | undefined,
        woocommerceOrderNumber: result.Item.woocommerceOrderNumber as string | undefined,
        notes: result.Item.notes as string | undefined,
        createdAt: result.Item.createdAt as string,
        updatedAt: result.Item.updatedAt as string,
      },
      result.Item.id as string
    );
  }

  async findByTenant(tenantId: string, pagination: PaginationInput, status?: string): Promise<PaginatedResult<Order>> {
    const limit = pagination.limit ?? 20;
    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: status
          ? 'GSI1PK = :pk AND begins_with(GSI1SK, :status)'
          : 'GSI1PK = :pk',
        ExpressionAttributeValues: status
          ? { ':pk': `TENANT#${tenantId}#ORDERS`, ':status': `ORDER#${status}` }
          : { ':pk': `TENANT#${tenantId}#ORDERS` },
        ScanIndexForward: false,
        Limit: limit + 1,
        ExclusiveStartKey: pagination.cursor
          ? JSON.parse(Buffer.from(pagination.cursor, 'base64').toString())
          : undefined,
      })
    );

    const items = result.Items ?? [];
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;

    return {
      data: page.map((item) =>
        Order.create(
          {
            tenantId: item.tenantId as string,
            customerPhone: item.customerPhone as string,
            customerName: item.customerName as string,
            items: item.items as import('../../domain/entities/Order.types').OrderItem[],
            total: item.total as number,
            currency: item.currency as string,
            status: item.status as OrderStatus,
            woocommerceOrderId: item.woocommerceOrderId as string | undefined,
            woocommerceOrderNumber: item.woocommerceOrderNumber as string | undefined,
            notes: item.notes as string | undefined,
            createdAt: item.createdAt as string,
            updatedAt: item.updatedAt as string,
          },
          item.id as string
        )
      ),
      cursor:
        hasMore && result.LastEvaluatedKey
          ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
          : undefined,
      hasMore,
    };
  }

  async save(order: Order): Promise<void> {
    await dynamoDb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: this.toItem(order),
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
  }

  async update(order: Order): Promise<void> {
    await dynamoDb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: this.toItem(order),
      })
    );
  }
}
