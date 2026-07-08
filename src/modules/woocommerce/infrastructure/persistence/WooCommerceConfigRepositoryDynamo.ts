import { GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { injectable } from 'tsyringe';
import { dynamoDb, TABLE_NAME } from '../../../../shared/infrastructure/persistence/DynamoDbClient';
import { IWooCommerceConfigRepository, WooCommerceConfigData } from '../../domain/IWooCommerceService';

@injectable()
export class WooCommerceConfigRepositoryDynamo implements IWooCommerceConfigRepository {
  async findByTenantId(tenantId: string): Promise<WooCommerceConfigData | null> {
    const result = await dynamoDb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantId}`, SK: 'WOOCOMMERCE' },
      })
    );

    if (!result.Item) return null;
    return result.Item as WooCommerceConfigData;
  }

  async save(config: WooCommerceConfigData): Promise<void> {
    await dynamoDb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `TENANT#${config.tenantId}`,
          SK: 'WOOCOMMERCE',
          entityType: 'WOOCOMMERCE_CONFIG',
          ...config,
        },
      })
    );
  }

  async delete(tenantId: string): Promise<void> {
    await dynamoDb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantId}`, SK: 'WOOCOMMERCE' },
      })
    );
  }
}
