/**
 * Crea PlatformTable y AuditLogTable en AWS DynamoDB (no local).
 * Usa AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION del .env
 * Ignora DYNAMODB_ENDPOINT.
 */
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import dotenv from 'dotenv';

dotenv.config();

const region = process.env.AWS_REGION ?? process.env.DYNAMODB_REGION ?? 'us-east-1';
const tableName = process.env.DYNAMODB_TABLE_NAME ?? 'PlatformTable';
const auditTableName = process.env.DYNAMODB_AUDIT_TABLE_NAME ?? 'AuditLogTable';

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error('❌ Faltan AWS_ACCESS_KEY_ID y AWS_SECRET_ACCESS_KEY en .env');
  process.exit(1);
}

const client = new DynamoDBClient({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

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
    console.log(`✓ ${tableName} ya existe`);
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

  console.log(`✓ Creada ${tableName}`);
}

async function createAuditTable(): Promise<void> {
  if (await tableExists(auditTableName)) {
    console.log(`✓ ${auditTableName} ya existe`);
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

  console.log(`✓ Creada ${auditTableName}`);
}

async function main(): Promise<void> {
  console.log(`Región: ${region}`);
  console.log('Creando tablas en AWS DynamoDB...\n');
  await createPlatformTable();
  await createAuditTable();
  console.log('\nListo. Para usar AWS en desarrollo, comenta o borra DYNAMODB_ENDPOINT en .env');
}

main().catch((err: unknown) => {
  const e = err as { name?: string; message?: string };
  console.error('\n❌ Error:', e.message ?? err);
  if (e.name === 'AccessDeniedException') {
    console.error('\nEl usuario IAM necesita permisos dynamodb:CreateTable, DescribeTable, etc.');
  }
  process.exit(1);
});
