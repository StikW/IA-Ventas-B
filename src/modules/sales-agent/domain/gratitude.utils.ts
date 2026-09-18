import { BbcUiRoute } from '../../builderbot/domain/BbcWebhookAgentResponse';
import { SalesContext } from './IChatSessionRepository';

const GRATITUDE_CORE =
  '(?:mil\\s+|muchas\\s+)?gracias(?:\\s+(?:por\\s+(?:la\\s+)?(?:info(?:rmaci[oó]n)?|ayuda|todo|atender(?:me)?|tu\\s+tiempo)))?|te\\s+lo\\s+agradezco|muy\\s+amable|gracias\\s+de\\s+verdad';

const GRATITUDE_ONLY_PATTERN = new RegExp(
  `^(?:${GRATITUDE_CORE}|(?:ok|vale|perfecto|genial|listo|super|s[uú]per)[,!\\s]+(?:${GRATITUDE_CORE}))\\.?$`,
  'i'
);

const GRATITUDE_PREFIX_PATTERN = new RegExp(`^(?:${GRATITUDE_CORE})[,!.\\s]+`, 'i');

const GRATITUDE_SUFFIX_PATTERN = new RegExp(`[,!.\\s]+(?:${GRATITUDE_CORE})\\.?$`, 'i');

export interface GratitudeStripResult {
  stripped: string;
  hadGratitude: boolean;
}

export interface GratitudeReply {
  body: string;
  uiRoute?: BbcUiRoute;
}

/** Quita agradecimiento al inicio o al final cuando el mensaje trae otra instrucción. */
export function stripGratitudeForProcessing(text: string): GratitudeStripResult {
  let stripped = text.trim();
  let hadGratitude = false;

  if (!stripped) return { stripped, hadGratitude };

  if (GRATITUDE_PREFIX_PATTERN.test(stripped)) {
    stripped = stripped.replace(GRATITUDE_PREFIX_PATTERN, '').trim();
    hadGratitude = true;
  }

  if (GRATITUDE_SUFFIX_PATTERN.test(stripped)) {
    stripped = stripped.replace(GRATITUDE_SUFFIX_PATTERN, '').trim();
    hadGratitude = true;
  }

  return { stripped, hadGratitude };
}

/** Solo agradecimiento, sin pedido ni instrucción adicional. */
export function isPureGratitude(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (GRATITUDE_ONLY_PATTERN.test(trimmed)) return true;

  const { stripped, hadGratitude } = stripGratitudeForProcessing(trimmed);
  return hadGratitude && stripped.length === 0;
}

/** Respuesta corta según la fase del flujo conversacional. */
export function buildGratitudeReply(context: SalesContext, checkoutUrl?: string): GratitudeReply {
  if (context.phase === 'awaiting_payment') {
    return {
      body: '¡Con gusto! Cuando tengas el comprobante, envíamelo por aquí 📸',
    };
  }

  if (context.flowStep === 'payment_select') {
    return {
      body: '¡Con gusto! Elige cómo prefieres pagar arriba, o escríbeme si tienes alguna duda.',
    };
  }

  if (context.flowStep === 'checkout_redirect') {
    const link = checkoutUrl ?? context.lastCheckoutUrl;
    const body = link
      ? `¡Con gusto! Si necesitas el enlace otra vez, aquí lo tienes:\n${link}`
      : '¡Con gusto! Si necesitas el enlace de compra otra vez, escríbeme *Finalizar pedido*.';
    return { body };
  }

  if (context.pendingPackQuote) {
    const quote = context.pendingPackQuote;
    return {
      body: `¡De nada! ¿Confirmamos los ${quote.desiredUnits} ${quote.unitPlural} o prefieres otra cantidad? Dime *sí* para agregarlos.`,
    };
  }

  if (context.pendingPackProduct) {
    return {
      body: '¡Con gusto! ¿Cuántas unidades necesitas?',
    };
  }

  if (context.lastOptions?.length) {
    return {
      body: '¡Con gusto! Si ya te decidiste, dime la *letra* o el *ID* del producto que quieres.',
    };
  }

  const hasCart = (context.cartItems?.length ?? 0) > 0;
  if (hasCart) {
    return {
      body: '¡Con gusto! Tu pedido sigue aquí. ¿Agregamos algo más o escribes *Finalizar pedido* para cerrar la compra?',
      uiRoute: 'finalize',
    };
  }

  return {
    body: '¡Con gusto! Si quieres armar tu pedido, envíame el *ID* del producto o descríbeme lo que buscas 😊',
    uiRoute: 'catalog',
  };
}
