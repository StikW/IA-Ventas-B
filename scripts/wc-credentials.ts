/**
 * Credenciales WooCommerce para los scripts de catálogo.
 *
 * Prioriza las variables de entorno; si no están, usa la config que el negocio guardó en el
 * panel (DynamoDB). Nunca imprime las credenciales: solo el origen desde donde se leyeron.
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { dynamoDb, TABLE_NAME } from '../src/shared/infrastructure/persistence/DynamoDbClient';

export interface WcCredentials {
  storeUrl: string;
  key: string;
  secret: string;
  source: string;
}

export function readFlag(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function resolveWcCredentials(): Promise<WcCredentials> {
  const storeUrl = (readFlag('--store') ?? process.env.WC_STORE_URL ?? '').replace(/\/$/, '');
  const key = readFlag('--key') ?? process.env.WC_CONSUMER_KEY ?? '';
  const secret = readFlag('--secret') ?? process.env.WC_CONSUMER_SECRET ?? '';
  if (storeUrl && key && secret) {
    return { storeUrl, key, secret, source: 'parámetros/entorno' };
  }

  const wanted = readFlag('--tenant');
  const result = await dynamoDb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': 'WOOCOMMERCE' },
    })
  );

  const configs = (result.Items ?? []) as Array<{
    tenantId: string;
    storeUrl: string;
    consumerKey: string;
    consumerSecret: string;
  }>;

  if (!configs.length) {
    throw new Error(
      'No hay configuración WooCommerce guardada. Usa --store/--key/--secret o WC_STORE_URL, WC_CONSUMER_KEY y WC_CONSUMER_SECRET.'
    );
  }

  const config = wanted ? configs.find((item) => item.tenantId === wanted) : configs[0];
  if (!config) {
    throw new Error(
      `El tenant ${wanted} no tiene WooCommerce configurado. Tenants disponibles: ${configs
        .map((item) => item.tenantId)
        .join(', ')}`
    );
  }

  return {
    storeUrl: config.storeUrl.replace(/\/$/, ''),
    key: config.consumerKey,
    secret: config.consumerSecret,
    source: `panel del negocio (tenant ${config.tenantId})`,
  };
}

export async function wcGet<T>(credentials: WcCredentials, path: string): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const url =
    `${credentials.storeUrl}/wp-json/wc/v3${path}${separator}` +
    `consumer_key=${encodeURIComponent(credentials.key)}&consumer_secret=${encodeURIComponent(credentials.secret)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`WooCommerce ${response.status} en ${path}: ${(await response.text()).slice(0, 300)}`);
  }
  return (await response.json()) as T;
}
