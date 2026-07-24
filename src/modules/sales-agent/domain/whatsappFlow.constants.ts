/** IDs estables para botones WhatsApp (Meta button_reply.id) */
import { isCartClearIntent, isCartCorrectionIntent, isCartRemoveIntent, isCartSetQuantityIntent } from './cartModification.utils';
import { extractVariantHint, hasConcreteProductSpec } from './productSelection.utils';

export const WA_BTN = {
  MENU_BUY: 'massi:menu:buy',
  MENU_ORDERS: 'massi:menu:orders',
  MENU_HELP: 'massi:menu:help',
  MENU_BACK: 'massi:menu:back',
  CART_ADD_MORE: 'massi:cart:more',
  CART_FINALIZE: 'massi:cart:finalize',
  PAY_TRANSFER: 'massi:pay:transfer',
  PAY_CASH: 'massi:pay:cash',
} as const;

export const WA_BTN_LABEL = {
  MENU_BUY: 'Comprar',
  MENU_ORDERS: 'Mi pedido',
  MENU_HELP: 'Ayuda',
  MENU_BACK: 'Menú',
  CART_ADD_MORE: 'Agregar más',
  CART_FINALIZE: 'Finalizar pedido',
  PAY_TRANSFER: 'Transferencia',
  PAY_CASH: 'Efectivo tienda',
} as const;

export const MENU_GREETING_PATTERN =
  /^(hola|buenos\s*d[ií]as|buenas\s*tardes|buenas\s*noches|buenas|menu|menú|inicio|hi|hello|ola|hey|start)$/i;

export function normalizeFlowText(text: string): string {
  return text.trim().toLowerCase();
}

export function isMenuGreeting(text: string): boolean {
  return MENU_GREETING_PATTERN.test(text.trim());
}

/** Cliente indica que terminó de elegir productos y quiere pagar. */
export function isCartFinalizeIntent(text: string): boolean {
  if (resolveButtonAction(text) === WA_BTN.CART_FINALIZE) return true;
  const t = normalizeFlowText(text);
  return (
    /^(eso\s+(?:es|ser[ií]a)\s+todo|es\s+todo|nada\s+m[aá]s|no\s+m[aá]s|listo|ya\s+est[aá]|finalizar(\s+(?:con\s+)?(?:la\s+)?compra)?|confirmar(\s+pedido)?)$/.test(
      t
    ) ||
    /continuar\s+con\s+la\s+compra|proceder\s+con\s+la\s+compra|finalizar\s+(?:con\s+)?(?:la\s+)?compra|finalicemos?\s+(?:con\s+)?(?:la\s+)?compra|cerrar\s+(?:el\s+)?pedido|quiero\s+(seguir|comprar|pagar|finalizar)|seguir\s+con\s+la\s+compra|listo\s+para\s+pagar|ya\s+no\s+quiero\s+m[aá]s/.test(
      t
    )
  );
}

/** Cliente quiere seguir agregando productos al carrito (sin especificar producto). */
export function isCartContinueShoppingIntent(text: string): boolean {
  if (resolveButtonAction(text) === WA_BTN.CART_ADD_MORE) return true;
  if (hasConcreteProductSpec(text)) return false;
  const t = normalizeFlowText(text);
  return /agregar|a[nñ]adir|algo\s+m[aá]s|otro\s+producto|m[aá]s\s+productos|s[ií],?\s+algo\s+m[aá]s|quiero\s+m[aá]s/.test(t);
}

/** Cliente elige o pide un producto concreto (no una pregunta de catálogo). Aplica a cualquier catálogo WC. */
export function isProductSelectionIntent(text: string): boolean {
  const t = normalizeFlowText(text);
  const trimmed = text.trim();

  if (
    isMenuGreeting(t) ||
    isCartFinalizeIntent(t) ||
    isCartContinueShoppingIntent(t) ||
    isCartClearIntent(text) ||
    isCartCorrectionIntent(text) ||
    isCartRemoveIntent(text) ||
    isCartSetQuantityIntent(text)
  ) {
    return false;
  }

  if (/^(qu[eé]|cu[aá]les|cu[aá]nto|tienen|hay|muestr|list|inform|productos?\s+(tienen|hay)|cat[aá]logo|precio\s+de)/.test(t)) {
    return false;
  }

  if (/^[A-Za-z0-9][A-Za-z0-9._-]{2,}$/.test(trimmed) && !/\s/.test(trimmed)) return true;

  if (/quiero|me gustar[ií]a|quisiera|dame|necesito|comprar|llevar|tomar|pedir|solicito|tambi[eé]n/.test(t)) return true;

  if (/\botra?\b/.test(t) && extractVariantHint(text)) return true;

  if (extractVariantHint(text) && t.split(/\s+/).filter(Boolean).length >= 2) return true;

  if (/\b\d+\s*(?:ud?s?|unidades?|pares?|piezas?|pzs?)\b/i.test(t)) return true;

  return false;
}

export function resolveButtonAction(text: string): string | null {
  const normalized = normalizeFlowText(text);
  const byLabel: Record<string, string> = {
    [normalizeFlowText(WA_BTN_LABEL.MENU_BUY)]: WA_BTN.MENU_BUY,
    [normalizeFlowText(WA_BTN_LABEL.MENU_ORDERS)]: WA_BTN.MENU_ORDERS,
    [normalizeFlowText(WA_BTN_LABEL.MENU_HELP)]: WA_BTN.MENU_HELP,
    [normalizeFlowText(WA_BTN_LABEL.CART_ADD_MORE)]: WA_BTN.CART_ADD_MORE,
    [normalizeFlowText(WA_BTN_LABEL.CART_FINALIZE)]: WA_BTN.CART_FINALIZE,
    [normalizeFlowText(WA_BTN_LABEL.PAY_TRANSFER)]: WA_BTN.PAY_TRANSFER,
    [normalizeFlowText(WA_BTN_LABEL.PAY_CASH)]: WA_BTN.PAY_CASH,
    [normalizeFlowText(WA_BTN_LABEL.MENU_BACK)]: WA_BTN.MENU_BACK,
    'menu principal': WA_BTN.MENU_BACK,
  };
  if (byLabel[normalized]) return byLabel[normalized];
  if (text.startsWith('massi:')) return text;
  return null;
}

/** Interpreta click de botón o texto libre equivalente al elegir método de pago. */
export function resolvePaymentMethodChoice(text: string): string | null {
  const fromButton = resolveButtonAction(text);
  if (fromButton === WA_BTN.PAY_TRANSFER || fromButton === WA_BTN.PAY_CASH || fromButton === WA_BTN.MENU_BACK) {
    return fromButton;
  }

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
