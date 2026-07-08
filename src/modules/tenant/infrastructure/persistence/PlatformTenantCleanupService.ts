import {
  BatchWriteCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { injectable } from 'tsyringe';
import { dynamoDb, TABLE_NAME, AUDIT_TABLE_NAME } from '../../../../shared/infrastructure/persistence/DynamoDbClient';

const BATCH_SIZE = 25;

@injectable()
export class PlatformTenantCleanupService {
  async deleteTenantData(tenantId: string): Promise<{ dynamoRecords: number; auditLogs: number; userIds: string[] }> {
    const userIds = await this.collectTenantUserIds(tenantId);
    let dynamoRecords = 0;
    let auditLogs = 0;

    dynamoRecords += await this.deletePartitionItems(`TENANT#${tenantId}`);
    dynamoRecords += await this.deleteByGsi1(`TENANT#${tenantId}#DOCS`);
    dynamoRecords += await this.deleteByGsi1(`TENANT#${tenantId}#ORDERS`);
    dynamoRecords += await this.deleteByPkPrefix(`TENANT#${tenantId}#CHAT#`);
    dynamoRecords += await this.deleteItem(`BUSINESS#${tenantId}`, 'METADATA');

    for (const userId of userIds) {
      dynamoRecords += await this.deletePartitionItems(`USER#${userId}`);
      dynamoRecords += await this.deleteItem(`USER#${userId}`, 'METADATA');
    }

    auditLogs = await this.deleteAuditLogs(tenantId);

    return { dynamoRecords, auditLogs, userIds };
  }

  private async collectTenantUserIds(tenantId: string): Promise<string[]> {
    const ids: string[] = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await dynamoDb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: 'GSI2',
          KeyConditionExpression: 'GSI2PK = :pk',
          ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#USERS` },
          ExclusiveStartKey: lastKey,
        })
      );

      for (const item of result.Items ?? []) {
        if (item.id) ids.push(String(item.id));
      }

      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return ids;
  }

  private async deletePartitionItems(pk: string): Promise<number> {
    let deleted = 0;
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await dynamoDb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': pk },
          ExclusiveStartKey: lastKey,
        })
      );

      const keys = (result.Items ?? []).map((item) => ({ PK: item.PK, SK: item.SK }));
      deleted += await this.batchDelete(TABLE_NAME, keys);
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return deleted;
  }

  private async deleteByGsi1(gsi1pk: string): Promise<number> {
    let deleted = 0;
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await dynamoDb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': gsi1pk },
          ExclusiveStartKey: lastKey,
        })
      );

      const keys = (result.Items ?? []).map((item) => ({ PK: item.PK, SK: item.SK }));
      deleted += await this.batchDelete(TABLE_NAME, keys);
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return deleted;
  }

  private async deleteByPkPrefix(pkPrefix: string): Promise<number> {
    let deleted = 0;
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await dynamoDb.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'begins_with(PK, :prefix)',
          ExpressionAttributeValues: { ':prefix': pkPrefix },
          ExclusiveStartKey: lastKey,
        })
      );

      const keys = (result.Items ?? []).map((item) => ({ PK: item.PK, SK: item.SK }));
      deleted += await this.batchDelete(TABLE_NAME, keys);
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return deleted;
  }

  private async deleteItem(pk: string, sk: string): Promise<number> {
    await dynamoDb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: pk, SK: sk },
      })
    );
    return 1;
  }

  private async deleteAuditLogs(tenantId: string): Promise<number> {
    let deleted = 0;
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await dynamoDb.send(
        new QueryCommand({
          TableName: AUDIT_TABLE_NAME,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#AUDIT` },
          ExclusiveStartKey: lastKey,
        })
      );

      const keys = (result.Items ?? []).map((item) => ({ PK: item.PK, SK: item.SK }));
      deleted += await this.batchDelete(AUDIT_TABLE_NAME, keys);
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return deleted;
  }

  private async batchDelete(
    tableName: string,
    keys: Array<{ PK: unknown; SK: unknown }>
  ): Promise<number> {
    if (!keys.length) return 0;

    let deleted = 0;

    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const chunk = keys.slice(i, i + BATCH_SIZE);
      await dynamoDb.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: chunk.map((key) => ({
              DeleteRequest: { Key: { PK: key.PK, SK: key.SK } },
            })),
          },
        })
      );
      deleted += chunk.length;
    }

    return deleted;
  }
}
