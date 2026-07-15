/** Normaliza teléfonos/JIDs de WhatsApp para envío por BuilderBot Cloud. */
export function normalizeBuilderBotPhone(phone: string): string {
  const raw = phone.trim();
  if (!raw || /\{\{.*\}\}/.test(raw)) return raw;

  const withoutJid = raw.split('@')[0] ?? raw;
  const digits = withoutJid.replace(/\D/g, '');
  return digits || withoutJid;
}

export function isBuilderBotTemplateLiteral(value?: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (/\{\{.*\}\}/.test(trimmed)) return true;
  return /^\{[a-zA-Z]+\}$/.test(trimmed);
}
