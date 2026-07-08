import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { injectable } from 'tsyringe';
import { dynamoDb, TABLE_NAME } from '../../../../shared/infrastructure/persistence/DynamoDbClient';
import { ApiKeyRecord } from '../../domain/entities/Config.types';
import { IApiKeyRepository } from '../../domain/repositories/IConfigRepository';

@injectable()
export class ApiKeyRepositoryDynamo implements IApiKeyRepository {
  async findByTenantId(tenantId: string): Promise<ApiKeyRecord | null> {
    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `TENANT#${tenantId}`,
          ':prefix': 'APIKEY#',
        },
        Limit: 10,
      })
    );

    const active = (result.Items ?? []).find((i) => !i.revokedAt);
    if (!active) return null;

    return this.toRecord(active);
  }

  async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :hash',
        ExpressionAttributeValues: { ':hash': `APIKEY#${keyHash}` },
        Limit: 1,
      })
    );

    const item = result.Items?.[0];
    if (!item || item.revokedAt) return null;
    return this.toRecord(item);
  }

  async save(record: ApiKeyRecord): Promise<void> {
    await dynamoDb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `TENANT#${record.tenantId}`,
          SK: `APIKEY#${record.id}`,
          GSI1PK: `APIKEY#${record.keyHash}`,
          GSI1SK: `TENANT#${record.tenantId}`,
          entityType: 'API_KEY',
          ...record,
        },
      })
    );
  }

  async revoke(id: string, tenantId: string): Promise<void> {
    await dynamoDb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantId}`, SK: `APIKEY#${id}` },
        UpdateExpression: 'SET revokedAt = :now',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      })
    );
  }

  private toRecord(item: Record<string, unknown>): ApiKeyRecord {
    return {
      id: item.id as string,
      tenantId: item.tenantId as string,
      keyHash: item.keyHash as string,
      keyPrefix: item.keyPrefix as string,
      createdAt: item.createdAt as string,
      revokedAt: item.revokedAt as string | undefined,
    };
  }
}
