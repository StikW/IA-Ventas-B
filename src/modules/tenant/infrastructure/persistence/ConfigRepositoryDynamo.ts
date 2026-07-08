import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { injectable } from 'tsyringe';
import { dynamoDb, TABLE_NAME } from '../../../../shared/infrastructure/persistence/DynamoDbClient';
import { BusinessConfig } from '../../domain/entities/BusinessConfig';
import { IConfigRepository } from '../../domain/repositories/IConfigRepository';

@injectable()
export class ConfigRepositoryDynamo implements IConfigRepository {
  async findByTenantId(tenantId: string): Promise<BusinessConfig | null> {
    const result = await dynamoDb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantId}`, SK: 'CONFIG' },
      })
    );

    if (!result.Item) return null;

    return BusinessConfig.create(
      {
        tenantId: result.Item.tenantId,
        business: result.Item.business ?? {},
        createdAt: result.Item.createdAt,
        updatedAt: result.Item.updatedAt,
      },
      tenantId
    );
  }

  async save(config: BusinessConfig): Promise<void> {
    const data = config.toJSON();
    await dynamoDb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `TENANT#${config.tenantId}`,
          SK: 'CONFIG',
          entityType: 'BUSINESS_CONFIG',
          ...data,
        },
      })
    );
  }
}
