import fs from 'fs/promises';
import path from 'path';
import { injectable } from 'tsyringe';
import { env } from '../../../../shared/infrastructure/config/env';
import { IStorageService, StorageReference } from '../../domain/ports/KnowledgePorts';

@injectable()
export class LocalStorageService implements IStorageService {
  private basePath = path.resolve(env.STORAGE_PATH);

  private resolveKey(key: string): string {
    return path.join(this.basePath, key);
  }

  async save(tenantId: string, documentId: string, filename: string, buffer: Buffer): Promise<StorageReference> {
    const key = path.join('tenants', tenantId, 'documents', documentId, filename);
    const fullPath = this.resolveKey(key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, buffer);
    return { key, path: fullPath };
  }

  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.resolveKey(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolveKey(key));
    } catch {
      // ignore missing files
    }
  }

  async deleteTenantFiles(tenantId: string): Promise<number> {
    const tenantDir = this.resolveKey(path.join('tenants', tenantId));
    let deleted = 0;

    const countFiles = async (dir: string): Promise<void> => {
      let entries: Array<{ name: string; isDirectory: () => boolean }>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory: () => boolean }>;
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await countFiles(fullPath);
        } else {
          deleted += 1;
        }
      }
    };

    await countFiles(tenantDir);

    try {
      await fs.rm(tenantDir, { recursive: true, force: true });
    } catch {
      // ignore missing tenant folder
    }

    return deleted;
  }
}
