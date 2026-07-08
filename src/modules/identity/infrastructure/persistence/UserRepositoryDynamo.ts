import {
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { injectable } from 'tsyringe';
import { dynamoDb, TABLE_NAME } from '../../../../shared/infrastructure/persistence/DynamoDbClient';
import { User } from '../../domain/entities/User';
import { UserRole, UserStatus } from '../../domain/entities/User.types';
import {
  CreateUserData,
  IUserRepository,
  UpdateUserData,
} from '../../domain/repositories/IUserRepository';
import { PaginatedResult, PaginationInput } from '../../../../shared/application/UseCase';
import { NotFoundError } from '../../../../shared/domain/errors/DomainError';

interface UserRecord {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  GSI2PK?: string;
  GSI2SK?: string;
  entityType: 'USER';
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  tenantId: string | null;
  status: UserStatus;
  profile: { firstName: string; lastName: string; phone?: string };
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

@injectable()
export class UserRepositoryDynamo implements IUserRepository {
  private toEntity(record: UserRecord): User {
    return User.create(
      {
        email: record.email,
        passwordHash: record.passwordHash,
        role: record.role,
        tenantId: record.tenantId,
        status: record.status,
        profile: record.profile,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastLoginAt: record.lastLoginAt,
      },
      record.id
    );
  }

  private toRecord(user: User): UserRecord {
    return {
      PK: `USER#${user.id}`,
      SK: 'METADATA',
      GSI1PK: `EMAIL#${user.email.toLowerCase()}`,
      GSI1SK: `USER#${user.id}`,
      GSI2PK: user.tenantId ? `TENANT#${user.tenantId}#USERS` : undefined,
      GSI2SK: user.tenantId ? `USER#${user.id}` : undefined,
      entityType: 'USER',
      id: user.id,
      email: user.email.toLowerCase(),
      passwordHash: user.passwordHash,
      role: user.role,
      tenantId: user.tenantId,
      status: user.status,
      profile: user.profile,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
    };
  }

  async findById(id: string): Promise<User | null> {
    const result = await dynamoDb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${id}`, SK: 'METADATA' },
      })
    );

    const record = result.Item as UserRecord | undefined;
    return record ? this.toEntity(record) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :email',
        ExpressionAttributeValues: { ':email': `EMAIL#${email.toLowerCase()}` },
        Limit: 1,
      })
    );

    const record = result.Items?.[0] as UserRecord | undefined;
    return record ? this.toEntity(record) : null;
  }

  async findByTenant(tenantId: string, pagination: PaginationInput): Promise<PaginatedResult<User>> {
    const limit = pagination.limit ?? 20;

    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#USERS` },
        Limit: limit + 1,
        ExclusiveStartKey: pagination.cursor
          ? JSON.parse(Buffer.from(pagination.cursor, 'base64').toString())
          : undefined,
      })
    );

    const items = (result.Items ?? []) as UserRecord[];
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

  async save(user: User): Promise<void> {
    await dynamoDb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: this.toRecord(user),
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
  }

  async update(
    id: string,
    data: Partial<CreateUserData & UpdateUserData & { lastLoginAt?: string; updatedAt: string }>
  ): Promise<User> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundError('Usuario no encontrado');

    const updated = User.create(
      {
        email: existing.email,
        passwordHash: data.passwordHash ?? existing.passwordHash,
        role: existing.role,
        tenantId: existing.tenantId,
        status: (data.status as UserStatus) ?? existing.status,
        profile: data.profile ? { ...existing.profile, ...data.profile } : existing.profile,
        createdAt: existing.createdAt,
        updatedAt: data.updatedAt ?? existing.updatedAt,
        lastLoginAt: data.lastLoginAt ?? existing.lastLoginAt,
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
