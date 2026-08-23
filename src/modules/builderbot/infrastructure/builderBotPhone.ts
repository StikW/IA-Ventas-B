/** Normaliza teléfonos/JIDs de WhatsApp para envío por BuilderBot Cloud. */
export function normalizeBuilderBotPhone(phone: string): string {
  const raw = phone.trim();
  if (!raw || /\{\{.*\}\}/.test(raw)) return raw;

  const withoutJid = raw.split('@')[0] ?? raw;
  const digits = withoutJid.replace(/\D/g, '');
  return digits || withoutJid;
}

/**
 * El checkout WC suele guardar el celular a 10 dígitos; la sesión WhatsApp va con
 * indicativo (57…). Probar ambas claves evita dejar el carrito del chat intacto.
 */
export function whatsappSessionPhoneCandidates(phone: string): string[] {
  const digits = normalizeBuilderBotPhone(phone).replace(/\D/g, '');
  if (digits.length < 10) return digits ? [digits] : [];

  const candidates = [digits];
  if (digits.startsWith('57') && digits.length === 12) {
    candidates.push(digits.slice(2));
  }
  if (digits.length === 10) {
    candidates.push(`57${digits}`);
  }

  return [...new Set(candidates)];
}

export function isBuilderBotTemplateLiteral(value?: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (/\{\{.*\}\}/.test(trimmed)) return true;
  return /^\{[a-zA-Z]+\}$/.test(trimmed);
}
