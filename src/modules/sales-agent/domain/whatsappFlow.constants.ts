/** IDs estables para botones WhatsApp (Meta button_reply.id) */
export const WA_BTN = {
  MENU_BUY: 'massi:menu:buy',
  MENU_ORDERS: 'massi:menu:orders',
  MENU_HELP: 'massi:menu:help',
  PAY_TRANSFER: 'massi:pay:transfer',
  PAY_CASH: 'massi:pay:cash',
  MENU_BACK: 'massi:menu:back',
} as const;

export const WA_BTN_LABEL = {
  MENU_BUY: 'Comprar',
  MENU_ORDERS: 'Mi pedido',
  MENU_HELP: 'Ayuda',
  PAY_TRANSFER: 'Transferencia',
  PAY_CASH: 'Efectivo tienda',
  MENU_BACK: 'Menú principal',
} as const;

export const MENU_GREETING_PATTERN =
  /^(hola|buenos\s*d[ií]as|buenas\s*tardes|buenas\s*noches|buenas|menu|menú|inicio|hi|hello|ola|hey|start)$/i;

export function normalizeFlowText(text: string): string {
  return text.trim().toLowerCase();
}

export function isMenuGreeting(text: string): boolean {
  return MENU_GREETING_PATTERN.test(text.trim());
}

export function resolveButtonAction(text: string): string | null {
  const normalized = normalizeFlowText(text);
  const byLabel: Record<string, string> = {
    [normalizeFlowText(WA_BTN_LABEL.MENU_BUY)]: WA_BTN.MENU_BUY,
    [normalizeFlowText(WA_BTN_LABEL.MENU_ORDERS)]: WA_BTN.MENU_ORDERS,
    [normalizeFlowText(WA_BTN_LABEL.MENU_HELP)]: WA_BTN.MENU_HELP,
    [normalizeFlowText(WA_BTN_LABEL.PAY_TRANSFER)]: WA_BTN.PAY_TRANSFER,
    [normalizeFlowText(WA_BTN_LABEL.PAY_CASH)]: WA_BTN.PAY_CASH,
    [normalizeFlowText(WA_BTN_LABEL.MENU_BACK)]: WA_BTN.MENU_BACK,
  };
  if (byLabel[normalized]) return byLabel[normalized];
  if (text.startsWith('massi:')) return text;
  return null;
}

const PAYMENT_NUMERIC: Record<string, string> = {
  '1': WA_BTN.PAY_TRANSFER,
  '2': WA_BTN.PAY_CASH,
  '3': WA_BTN.MENU_BACK,
};

/** Interpreta texto libre o número cuando el cliente elige método de pago sin botones. */
export function resolvePaymentMethodChoice(text: string): string | null {
  const fromButton = resolveButtonAction(text);
  if (fromButton === WA_BTN.PAY_TRANSFER || fromButton === WA_BTN.PAY_CASH || fromButton === WA_BTN.MENU_BACK) {
    return fromButton;
  }

  const normalized = normalizeFlowText(text);
  if (PAYMENT_NUMERIC[normalized]) return PAYMENT_NUMERIC[normalized];

  if (/transfer|bre-?b|consign|transferencia|pagar\s+(en\s+)?(su\s+)?totalidad|pagar\s+por\s+transfer/i.test(text)) {
    return WA_BTN.PAY_TRANSFER;
  }
  if (/efectivo|cash|tienda|ventanilla|presencial|pago\s+en\s+tienda/i.test(text)) {
    return WA_BTN.PAY_CASH;
  }
  if (/men[uú]|inicio|volver|atr[aá]s|cancel/i.test(text)) {
    return WA_BTN.MENU_BACK;
  }

  return null;
}

export function formatPaymentMethodChoicesHint(): string {
  return [
    'Responde con el número o escribe la opción:',
    `1️⃣ ${WA_BTN_LABEL.PAY_TRANSFER}`,
    `2️⃣ ${WA_BTN_LABEL.PAY_CASH}`,
    `3️⃣ ${WA_BTN_LABEL.MENU_BACK}`,
  ].join('\n');
}
