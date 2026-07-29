import OpenAI from 'openai';
import { env } from '../config/env';

/** URL fija para evitar 404 Invalid URL si OPENAI_BASE_URL está vacía en el servidor. */
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

export function createOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY!.trim(),
    baseURL: OPENAI_API_BASE_URL,
  });
}
