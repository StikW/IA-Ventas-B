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

export interface ToolCallHandler {
  (name: string, args: Record<string, unknown>): Promise<string>;
}

export interface ChatWithToolsInput extends ChatCompletionInput {
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  onToolCall: ToolCallHandler;
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
      max_tokens: 700,
    });

    const reply = response.choices[0]?.message?.content?.trim();
    if (!reply) {
      throw new DomainError('OpenAI no devolvió una respuesta', 'OPENAI_EMPTY_RESPONSE');
    }

    return reply;
  }

  async completeWithTools(input: ChatWithToolsInput): Promise<string> {
    const client = this.getClient();
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: input.systemPrompt },
      ...input.history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: 'user', content: input.userMessage },
    ];

    for (let step = 0; step < 6; step += 1) {
      const response = await client.chat.completions.create({
        model: env.OPENAI_CHAT_MODEL,
        messages,
        tools: input.tools,
        tool_choice: 'auto',
        temperature: 0.35,
        max_tokens: 700,
      });

      const choice = response.choices[0]?.message;
      if (!choice) {
        throw new DomainError('OpenAI no devolvió una respuesta', 'OPENAI_EMPTY_RESPONSE');
      }

      if (choice.tool_calls?.length) {
        messages.push(choice);
        for (const toolCall of choice.tool_calls) {
          if (toolCall.type !== 'function') continue;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
          } catch {
            args = {};
          }
          const result = await input.onToolCall(toolCall.function.name, args);
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result,
          });
        }
        continue;
      }

      const reply = choice.content?.trim();
      if (!reply) {
        throw new DomainError('OpenAI no devolvió una respuesta', 'OPENAI_EMPTY_RESPONSE');
      }
      return reply;
    }

    throw new DomainError('El agente excedió el límite de llamadas a herramientas', 'OPENAI_TOOL_LIMIT');
  }
}
