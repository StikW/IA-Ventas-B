import { inject, injectable } from 'tsyringe';
import { UseCase } from '../../../../shared/application/UseCase';
import { RagSearchService } from '../services/RagSearchService';

export interface KnowledgeSearchInput {
  tenantId: string;
  query: string;
  topK?: number;
  minScore?: number;
}

@injectable()
export class KnowledgeSearchUseCase implements UseCase<KnowledgeSearchInput, Awaited<ReturnType<RagSearchService['search']>>> {
  constructor(@inject(RagSearchService) private readonly ragSearch: RagSearchService) {}

  async execute(input: KnowledgeSearchInput) {
    return this.ragSearch.search(input);
  }
}
