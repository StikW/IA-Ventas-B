import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { injectable } from 'tsyringe';
import { dynamoDb, TABLE_NAME } from '../../../../shared/infrastructure/persistence/DynamoDbClient';
import {
  IRefreshTokenRepository,
  RefreshTokenRecord,
} from '../../domain/repositories/IUserRepository';

@injectable()
export class RefreshTokenRepositoryDynamo implements IRefreshTokenRepository {
  async save(record: RefreshTokenRecord): Promise<void> {
    await dynamoDb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `USER#${record.userId}`,
          SK: `REFRESH#${record.id}`,
          GSI1PK: `TOKEN#${record.tokenHash}`,
          GSI1SK: `REFRESH#${record.id}`,
          entityType: 'REFRESH_TOKEN',
          ...record,
        },
      })
    );
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :hash',
        ExpressionAttributeValues: { ':hash': `TOKEN#${tokenHash}` },
        Limit: 1,
      })
    );

    const item = result.Items?.[0];
    if (!item || item.revokedAt) return null;
    if (new Date(item.expiresAt) < new Date()) return null;

    return {
      id: item.id,
      userId: item.userId,
      tokenHash: item.tokenHash,
      expiresAt: item.expiresAt,
      revokedAt: item.revokedAt,
      createdAt: item.createdAt,
    };
  }

  async revoke(id: string, userId: string): Promise<void> {
    await dynamoDb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${userId}`, SK: `REFRESH#${id}` },
        UpdateExpression: 'SET revokedAt = :now',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      })
    );
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `USER#${userId}`,
          ':prefix': 'REFRESH#',
        },
      })
    );

    const now = new Date().toISOString();
    for (const item of result.Items ?? []) {
      if (!item.revokedAt) {
        await dynamoDb.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { PK: item.PK, SK: item.SK },
            UpdateExpression: 'SET revokedAt = :now',
            ExpressionAttributeValues: { ':now': now },
          })
        );
      }
    }
  }
}
