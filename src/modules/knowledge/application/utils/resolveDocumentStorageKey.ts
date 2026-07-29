import { Document } from '../../domain/entities/Document';

/** Reconstruye la key S3/local si registros antiguos perdieron storageKey al persistir. */
export function resolveDocumentStorageKey(document: Document): string {
  const key = document.storageKey?.trim();
  if (key) return key;
  return `tenants/${document.tenantId}/documents/${document.id}/${document.filename}`;
}
