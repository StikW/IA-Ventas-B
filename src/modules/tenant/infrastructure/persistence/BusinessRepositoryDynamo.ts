import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { injectable } from 'tsyringe';
import { dynamoDb, TABLE_NAME } from '../../../../shared/infrastructure/persistence/DynamoDbClient';
import { Business } from '../../domain/entities/Business';
import { BusinessStatus } from '../../domain/entities/Business.types';
import { IBusinessRepository, UpdateBusinessData } from '../../domain/repositories/IBusinessRepository';
import { PaginatedResult, PaginationInput } from '../../../../shared/application/UseCase';
import { NotFoundError } from '../../../../shared/domain/errors/DomainError';

interface BusinessRecord {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entityType: 'BUSINESS';
  id: string;
  name: string;
  slug: string;
  status: BusinessStatus;
  contactEmail: string;
  contactPhone?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

@injectable()
export class BusinessRepositoryDynamo implements IBusinessRepository {
  private toEntity(record: BusinessRecord): Business {
    return Business.create(
      {
        name: record.name,
        slug: record.slug,
        status: record.status,
        contactEmail: record.contactEmail,
        contactPhone: record.contactPhone,
        createdBy: record.createdBy,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      record.id
    );
  }

  private toRecord(business: Business): BusinessRecord {
    return {
      PK: `BUSINESS#${business.id}`,
      SK: 'METADATA',
      GSI1PK: `STATUS#${business.status}`,
      GSI1SK: `BUSINESS#${business.id}`,
      entityType: 'BUSINESS',
      id: business.id,
      name: business.name,
      slug: business.slug,
      status: business.status,
      contactEmail: business.contactEmail,
      contactPhone: business.contactPhone,
      createdBy: business.createdBy,
      createdAt: business.createdAt,
      updatedAt: business.updatedAt,
    };
  }

  async findById(id: string): Promise<Business | null> {
    const result = await dynamoDb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `BUSINESS#${id}`, SK: 'METADATA' },
      })
    );
    return result.Item ? this.toEntity(result.Item as BusinessRecord) : null;
  }

  async findBySlug(slug: string): Promise<Business | null> {
    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :status',
        FilterExpression: 'slug = :slug',
        ExpressionAttributeValues: {
          ':status': `STATUS#ACTIVE`,
          ':slug': slug,
        },
      })
    );

    const match = (result.Items ?? []).find((i) => i.slug === slug) as BusinessRecord | undefined;
    if (match) return this.toEntity(match);

    const allResult = await dynamoDb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :inactive',
        FilterExpression: 'slug = :slug',
        ExpressionAttributeValues: {
          ':inactive': `STATUS#INACTIVE`,
          ':slug': slug,
        },
      })
    );

    const inactiveMatch = (allResult.Items ?? []).find((i) => i.slug === slug) as BusinessRecord | undefined;
    return inactiveMatch ? this.toEntity(inactiveMatch) : null;
  }

  async listByStatus(status: string | null, pagination: PaginationInput): Promise<PaginatedResult<Business>> {
    const limit = pagination.limit ?? 20;

    if (!status) {
      const statuses = [BusinessStatus.ACTIVE, BusinessStatus.INACTIVE, BusinessStatus.SUSPENDED];
      const all: Business[] = [];
      for (const s of statuses) {
        const result = await dynamoDb.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            IndexName: 'GSI1',
            KeyConditionExpression: 'GSI1PK = :pk',
            ExpressionAttributeValues: { ':pk': `STATUS#${s}` },
          })
        );
        all.push(...(result.Items ?? []).map((i) => this.toEntity(i as BusinessRecord)));
      }
      return { data: all.slice(0, limit), hasMore: all.length > limit };
    }

    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `STATUS#${status}` },
        Limit: limit + 1,
        ExclusiveStartKey: pagination.cursor
          ? JSON.parse(Buffer.from(pagination.cursor, 'base64').toString())
          : undefined,
      })
    );

    const items = (result.Items ?? []) as BusinessRecord[];
    const hasMore = items.length > limit;
    const pageItems = hasMore ? items.slice(0, limit) : items;

    return {
      data: pageItems.map((r) => this.toEntity(r)),
      cursor:
        hasMore && result.LastEvaluatedKey
          ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
          : undefined,
      hasMore,
    };
  }

  async save(business: Business): Promise<void> {
    await dynamoDb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: this.toRecord(business),
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
  }

  async update(id: string, data: UpdateBusinessData): Promise<Business> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundError('Negocio no encontrado');

    const updated = Business.create(
      {
        name: data.name ?? existing.name,
        slug: data.slug ?? existing.slug,
        status: (data.status as BusinessStatus) ?? existing.status,
        contactEmail: data.contactEmail ?? existing.contactEmail,
        contactPhone:
          data.contactPhone !== undefined ? data.contactPhone || undefined : existing.contactPhone,
        createdBy: existing.createdBy,
        createdAt: existing.createdAt,
        updatedAt: data.updatedAt,
      },
      existing.id
    );

    await dynamoDb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: this.toRecord(updated),
      })
    );

    return updated;
  }
}
