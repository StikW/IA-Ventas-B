import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { injectable } from 'tsyringe';
import { dynamoDb, TABLE_NAME } from '../../../../shared/infrastructure/persistence/DynamoDbClient';
import { ChatMessage, ChatSession, IChatSessionRepository } from '../../domain/IChatSessionRepository';

const MAX_MESSAGES = 20;

function sessionKey(tenantId: string, customerPhone: string) {
  const phone = customerPhone.replace(/\D/g, '');
  return {
    PK: `TENANT#${tenantId}#CHAT#${phone}`,
    SK: 'SESSION',
  };
}

@injectable()
export class ChatSessionRepositoryDynamo implements IChatSessionRepository {
  async find(tenantId: string, customerPhone: string): Promise<ChatSession | null> {
    const result = await dynamoDb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: sessionKey(tenantId, customerPhone),
      })
    );

    if (!result.Item) return null;

    return {
      tenantId,
      customerPhone,
      messages: (result.Item.messages as ChatMessage[]) ?? [],
      salesContext: result.Item.salesContext as ChatSession['salesContext'],
      updatedAt: String(result.Item.updatedAt ?? ''),
    };
  }

  async save(session: ChatSession): Promise<void> {
    const messages = session.messages.slice(-MAX_MESSAGES);
    const now = new Date().toISOString();

    await dynamoDb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...sessionKey(session.tenantId, session.customerPhone),
          entityType: 'CHAT_SESSION',
          tenantId: session.tenantId,
          customerPhone: session.customerPhone,
          messages,
          salesContext: session.salesContext,
          updatedAt: now,
        },
      })
    );
  }
}
