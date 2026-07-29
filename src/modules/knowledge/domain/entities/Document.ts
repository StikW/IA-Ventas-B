import { Entity } from '../../../../shared/domain/Entity';
import { DocumentProps, DocumentStatus } from '../ports/KnowledgePorts';

export class Document extends Entity<DocumentProps> {
  private constructor(props: DocumentProps, id: string) {
    super(props, id);
  }

  static create(props: DocumentProps, id: string): Document {
    return new Document(props, id);
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get filename(): string {
    return this.props.filename;
  }

  get status(): DocumentStatus {
    return this.props.status;
  }

  get mimeType(): string {
    return this.props.mimeType;
  }

  get size(): number {
    return this.props.size;
  }

  get storageKey(): string {
    return this.props.storageKey;
  }

  get chunkCount(): number {
    return this.props.chunkCount;
  }

  get vectorCount(): number {
    return this.props.vectorCount;
  }

  get createdAt(): string {
    return this.props.createdAt;
  }

  withStatus(status: DocumentStatus, extra?: Partial<DocumentProps>): Document {
    return Document.create(
      {
        ...this.props,
        ...extra,
        status,
        updatedAt: new Date().toISOString(),
      },
      this.id
    );
  }

  toJSON() {
    return {
      id: this.id,
      tenantId: this.tenantId,
      filename: this.filename,
      mimeType: this.mimeType,
      size: this.size,
      storageKey: this.storageKey,
      status: this.status,
      chunkCount: this.chunkCount,
      vectorCount: this.vectorCount,
      errorMessage: this.props.errorMessage,
      createdAt: this.createdAt,
      updatedAt: this.props.updatedAt,
      processedAt: this.props.processedAt,
    };
  }
}
