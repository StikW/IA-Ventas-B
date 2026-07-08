export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  at: string;
}

export interface ChatSession {
  tenantId: string;
  customerPhone: string;
  messages: ChatMessage[];
  updatedAt: string;
}

export interface IChatSessionRepository {
  find(tenantId: string, customerPhone: string): Promise<ChatSession | null>;
  save(session: ChatSession): Promise<void>;
}
