import { GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { injectable } from 'tsyringe';
import { dynamoDb, TABLE_NAME } from '../../../../shared/infrastructure/persistence/DynamoDbClient';
import { BuilderBotConfigData, IBuilderBotConfigRepository } from '../../domain/IBuilderBotCloudService';

@injectable()
export class BuilderBotConfigRepositoryDynamo implements IBuilderBotConfigRepository {
  async findByTenantId(tenantId: string): Promise<BuilderBotConfigData | null> {
    const result = await dynamoDb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantId}`, SK: 'BUILDERBOT' },
      })
    );
    if (!result.Item) return null;
    return result.Item as BuilderBotConfigData;
  }

  async save(config: BuilderBotConfigData): Promise<void> {
    await dynamoDb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `TENANT#${config.tenantId}`,
          SK: 'BUILDERBOT',
          entityType: 'BUILDERBOT_CONFIG',
          ...config,
        },
      })
    );
  }

  async delete(tenantId: string): Promise<void> {
    await dynamoDb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantId}`, SK: 'BUILDERBOT' },
      })
    );
  }
}
