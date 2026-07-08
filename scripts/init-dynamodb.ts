import {
  CreateTableCommand,
  DynamoDBClient,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import dotenv from 'dotenv';

dotenv.config();

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const region = process.env.DYNAMODB_REGION ?? 'us-east-1';
const tableName = process.env.DYNAMODB_TABLE_NAME ?? 'PlatformTable';
const auditTableName = process.env.DYNAMODB_AUDIT_TABLE_NAME ?? 'AuditLogTable';
const maxRetries = 15;
const retryDelayMs = 1000;

const client = new DynamoDBClient({
  region,
  endpoint,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

async function waitForDynamoDb(): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.send(new DescribeTableCommand({ TableName: '___healthcheck___' }));
      return;
    } catch (err: unknown) {
      const error = err as { name?: string; code?: string };
      if (error.name === 'ResourceNotFoundException') {
        return;
      }
      if (error.code === 'ECONNREFUSED' || error.name === 'TimeoutError') {
        if (attempt === maxRetries) {
          console.error('\n❌ No se pudo conectar a DynamoDB Local en', endpoint);
          console.error('\nInicia DynamoDB Local primero (elige una opción):\n');
          console.error('  Opción A — Sin Docker (recomendado en Windows):');
          console.error('    npm run dynamodb:start\n');
          console.error('  Opción B — Con Docker Desktop:');
          console.error('    docker compose up -d dynamodb-local\n');
          process.exit(1);
        }
        console.log(`Esperando DynamoDB Local... (${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      throw err;
    }
  }
}

async function tableExists(name: string): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch {
    return false;
  }
}

async function createPlatformTable(): Promise<void> {
  if (await tableExists(tableName)) {
    console.log(`Table ${tableName} already exists`);
    return;
  }

  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
        { AttributeName: 'GSI2PK', AttributeType: 'S' },
        { AttributeName: 'GSI2SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'GSI2PK', KeyType: 'HASH' },
            { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    })
  );

  console.log(`Created table ${tableName}`);
}

async function createAuditTable(): Promise<void> {
  if (await tableExists(auditTableName)) {
    console.log(`Table ${auditTableName} already exists`);
    return;
  }

  await client.send(
    new CreateTableCommand({
      TableName: auditTableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    })
  );

  console.log(`Created table ${auditTableName}`);
}

async function main(): Promise<void> {
  await waitForDynamoDb();
  await createPlatformTable();
  await createAuditTable();
  console.log('DynamoDB initialization complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
