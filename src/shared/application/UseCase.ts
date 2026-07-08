export interface UseCase<TInput, TOutput> {
  execute(input: TInput): Promise<TOutput>;
}

export interface TenantContext {
  tenantId: string | null;
  userId: string;
  role: string;
  email: string;
}

export interface PaginationInput {
  limit?: number;
  cursor?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  cursor?: string;
  hasMore: boolean;
}
