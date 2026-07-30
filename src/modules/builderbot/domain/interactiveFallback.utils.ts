import {
  SendButtonsMessageInput,
  SendCtaUrlMessageInput,
  SendListMessageInput,
} from './IBuilderBotCloudService';

export function joinTextBlocks(blocks: (string | undefined)[]): string {
  return blocks
    .map((block) => block?.trim())
    .filter((block): block is string => Boolean(block))
    .join('\n\n');
}

export function renderButtonOptions(buttons: { body: string }[]): string {
  if (!buttons.length) return '';
  const options = buttons.map((btn) => `• *${btn.body.trim()}*`).join('\n');
  return `Responde con una de estas opciones:\n${options}`;
}

/** `intro` reemplaza la etiqueta del botón cuando el mensaje ya presenta el enlace. */
export function renderLinkBlock(displayText: string, url: string, intro?: string): string {
  const label = intro?.trim() || `${displayText.trim()}:`;
  return `${label}\n${url.trim()}`;
}

export function renderButtonsAsText(input: SendButtonsMessageInput): string {
  return joinTextBlocks([input.body, renderButtonOptions(input.buttons), input.footer]);
}

export function renderCtaUrlAsText(input: Omit<SendCtaUrlMessageInput, 'deviceId' | 'phone'>): string {
  return joinTextBlocks([input.body, renderLinkBlock(input.displayText, input.url), input.footer]);
}

export function renderListAsText(input: SendListMessageInput): string {
  const lines = input.sections.flatMap((section) => [
    section.title.trim() ? `*${section.title.trim()}*` : null,
    ...section.rows
      .slice(0, 10)
      .map((row) => `• ${row.title}${row.description ? ` — ${row.description}` : ''}`),
  ]);

  return joinTextBlocks([input.title, input.body, lines.filter(Boolean).join('\n'), input.footer]);
}
