import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { env } from '../config/env';

const clientConfig: ConstructorParameters<typeof DynamoDBClient>[0] = {
  region: env.DYNAMODB_REGION,
};

if (env.DYNAMODB_ENDPOINT) {
  clientConfig.endpoint = env.DYNAMODB_ENDPOINT;
  clientConfig.credentials = {
    accessKeyId: 'local',
    secretAccessKey: 'local',
  };
}

const client = new DynamoDBClient(clientConfig);

export const dynamoDb = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: false,
  },
});

export const TABLE_NAME = env.DYNAMODB_TABLE_NAME;
export const AUDIT_TABLE_NAME = env.DYNAMODB_AUDIT_TABLE_NAME;
