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
