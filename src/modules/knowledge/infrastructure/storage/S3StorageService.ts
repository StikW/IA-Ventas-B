import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { injectable } from 'tsyringe';
import { env } from '../../../../shared/infrastructure/config/env';
import { IStorageService, StorageReference } from '../../domain/ports/KnowledgePorts';

@injectable()
export class S3StorageService implements IStorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    if (!env.S3_BUCKET || !env.AWS_REGION) {
      throw new Error('S3_BUCKET y AWS_REGION son requeridos para S3StorageService');
    }

    this.bucket = env.S3_BUCKET;
    this.client = new S3Client({
      region: env.AWS_REGION,
      credentials:
        env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            }
          : undefined,
    });
  }

  private buildKey(tenantId: string, documentId: string, filename: string): string {
    return `tenants/${tenantId}/documents/${documentId}/${filename}`;
  }

  async save(tenantId: string, documentId: string, filename: string, buffer: Buffer): Promise<StorageReference> {
    const key = this.buildKey(tenantId, documentId, filename);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: this.guessContentType(filename),
      })
    );

    return { key, path: `s3://${this.bucket}/${key}` };
  }

  async read(key: string): Promise<Buffer> {
    if (!key?.trim()) {
      throw new Error('storageKey vacío: no se puede leer el archivo');
    }

    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );

    const body = result.Body;
    if (!body) throw new Error('Archivo vacío en S3');

    return Buffer.from(await body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    if (!key?.trim()) return;

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }

  async deleteTenantFiles(tenantId: string): Promise<number> {
    const prefix = `tenants/${tenantId}/`;
    let deleted = 0;
    let continuationToken: string | undefined;

    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      const keys = (listed.Contents ?? []).map((item) => item.Key).filter(Boolean) as string[];
      if (keys.length) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: keys.map((Key) => ({ Key })),
            },
          })
        );
        deleted += keys.length;
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);

    return deleted;
  }

  private guessContentType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop();
    const map: Record<string, string> = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      txt: 'text/plain',
    };
    return map[ext ?? ''] ?? 'application/octet-stream';
  }
}
