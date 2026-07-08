import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { injectable } from 'tsyringe';
import { dynamoDb, AUDIT_TABLE_NAME } from '../../infrastructure/persistence/DynamoDbClient';
import { generateId } from '../../infrastructure/utils/crypto.utils';

export interface AuditEvent {
  tenantId: string | null;
  userId: string;
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

@injectable()
export class AuditService {
  async log(event: AuditEvent): Promise<void> {
    const now = new Date().toISOString();
    const id = generateId();
    const pk = event.tenantId ? `TENANT#${event.tenantId}#AUDIT` : 'GLOBAL#AUDIT';

    await dynamoDb.send(
      new PutCommand({
        TableName: AUDIT_TABLE_NAME,
        Item: {
          PK: pk,
          SK: `${now}#${id}`,
          GSI1PK: `USER#${event.userId}`,
          GSI1SK: now,
          entityType: 'AUDIT_LOG',
          id,
          tenantId: event.tenantId,
          userId: event.userId,
          action: event.action,
          resource: event.resource,
          resourceId: event.resourceId,
          metadata: event.metadata,
          createdAt: now,
        },
      })
    );
  }

  async listByTenant(tenantId: string, limit = 50): Promise<Record<string, unknown>[]> {
    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: AUDIT_TABLE_NAME,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#AUDIT` },
        ScanIndexForward: false,
        Limit: limit,
      })
    );

    return (result.Items ?? []).map((item) => ({
      id: item.id,
      action: item.action,
      resource: item.resource,
      resourceId: item.resourceId,
      userId: item.userId,
      metadata: item.metadata,
      createdAt: item.createdAt,
    }));
  }
}
