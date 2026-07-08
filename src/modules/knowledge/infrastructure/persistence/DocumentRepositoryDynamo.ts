import { GetCommand, PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { injectable } from 'tsyringe';
import { dynamoDb, TABLE_NAME } from '../../../../shared/infrastructure/persistence/DynamoDbClient';
import { Document } from '../../domain/entities/Document';
import { DocumentStatus } from '../../domain/ports/KnowledgePorts';
import { IDocumentRepository } from '../../domain/repositories/IDocumentRepository';
import { PaginatedResult, PaginationInput } from '../../../../shared/application/UseCase';

@injectable()
export class DocumentRepositoryDynamo implements IDocumentRepository {
  private toEntity(item: Record<string, unknown>): Document {
    return Document.create(
      {
        tenantId: item.tenantId as string,
        filename: item.filename as string,
        mimeType: item.mimeType as string,
        size: item.size as number,
        storageKey: item.storageKey as string,
        status: item.status as DocumentStatus,
        chunkCount: (item.chunkCount as number) ?? 0,
        vectorCount: (item.vectorCount as number) ?? 0,
        errorMessage: item.errorMessage as string | undefined,
        createdAt: item.createdAt as string,
        updatedAt: item.updatedAt as string,
        processedAt: item.processedAt as string | undefined,
      },
      item.id as string
    );
  }

  private toItem(doc: Document) {
    const json = doc.toJSON();
    return {
      PK: `TENANT#${doc.tenantId}#DOC#${doc.id}`,
      SK: 'METADATA',
      GSI1PK: `TENANT#${doc.tenantId}#DOCS`,
      GSI1SK: `DOC#${json.createdAt}#${doc.id}`,
      entityType: 'DOCUMENT',
      ...json,
    };
  }

  async findById(tenantId: string, id: string): Promise<Document | null> {
    const result = await dynamoDb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantId}#DOC#${id}`, SK: 'METADATA' },
      })
    );
    return result.Item ? this.toEntity(result.Item) : null;
  }

  async findByTenant(tenantId: string, pagination: PaginationInput): Promise<PaginatedResult<Document>> {
    const limit = pagination.limit ?? 20;
    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#DOCS` },
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
      data: page.map((i) => this.toEntity(i)),
      cursor:
        hasMore && result.LastEvaluatedKey
          ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
          : undefined,
      hasMore,
    };
  }

  async save(document: Document): Promise<void> {
    await dynamoDb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: this.toItem(document),
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
  }

  async update(document: Document): Promise<void> {
    await dynamoDb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: this.toItem(document),
      })
    );
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await dynamoDb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: `TENANT#${tenantId}#DOC#${id}`, SK: 'METADATA' },
      })
    );
  }
}
