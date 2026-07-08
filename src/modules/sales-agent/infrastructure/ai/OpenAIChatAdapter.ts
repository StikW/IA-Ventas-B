import OpenAI from 'openai';
import { injectable } from 'tsyringe';
import { env, hasOpenAI } from '../../../../shared/infrastructure/config/env';
import { DomainError } from '../../../../shared/domain/errors/DomainError';
import { ChatMessage } from '../../domain/IChatSessionRepository';

export interface ChatCompletionInput {
  systemPrompt: string;
  history: ChatMessage[];
  userMessage: string;
}

@injectable()
export class OpenAIChatAdapter {
  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    if (!hasOpenAI) {
      throw new DomainError(
        'OPENAI_API_KEY no configurada. Requerida para el agente de ventas.',
        'OPENAI_NOT_CONFIGURED'
      );
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }
    return this.client;
  }

  async complete(input: ChatCompletionInput): Promise<string> {
    const client = this.getClient();

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: input.systemPrompt },
      ...input.history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: 'user', content: input.userMessage },
    ];

    const response = await client.chat.completions.create({
      model: env.OPENAI_CHAT_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 600,
    });

    const reply = response.choices[0]?.message?.content?.trim();
    if (!reply) {
      throw new DomainError('OpenAI no devolvió una respuesta', 'OPENAI_EMPTY_RESPONSE');
    }

    return reply;
  }
}
