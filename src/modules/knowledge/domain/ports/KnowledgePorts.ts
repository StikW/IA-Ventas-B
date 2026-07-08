export enum DocumentStatus {
  UPLOADED = 'UPLOADED',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
}

export interface DocumentProps {
  tenantId: string;
  filename: string;
  mimeType: string;
  size: number;
  storageKey: string;
  status: DocumentStatus;
  chunkCount: number;
  vectorCount: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  processedAt?: string;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export interface VectorMetadata {
  tenantId: string;
  documentId: string;
  chunkIndex: number;
  source: string;
  content: string;
  contentPreview: string;
}

export interface QueryResult {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

export interface EmbedRequest {
  texts: string[];
}

export interface EmbedResponse {
  embeddings: number[][];
  model: string;
  dimensions: number;
}

export interface IEmbeddingProvider {
  embed(request: EmbedRequest): Promise<EmbedResponse>;
}

export interface IVectorStore {
  upsert(namespace: string, vectors: VectorRecord[]): Promise<void>;
  query(namespace: string, embedding: number[], topK: number): Promise<QueryResult[]>;
  deleteByDocument(namespace: string, documentId: string): Promise<void>;
  deleteNamespace(namespace: string): Promise<void>;
}

export interface StorageReference {
  key: string;
  path: string;
}

export interface IStorageService {
  save(tenantId: string, documentId: string, filename: string, buffer: Buffer): Promise<StorageReference>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  deleteTenantFiles(tenantId: string): Promise<number>;
}

export interface IDocumentParser {
  supports(mimeType: string, filename: string): boolean;
  extract(buffer: Buffer, filename: string): Promise<string>;
}
