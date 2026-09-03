/**
 * Precios por paquete (x10 / x5 / x2 / x1) — misma lógica que `woo-massi`
 * (`wm-promotion-product.js` → `compose`).
 *
 * En WooCommerce el producto es *simple* (un SKU, p. ej. BAL-10DA). Los 4 precios
 * viven en el plugin `woo-massi` (meta + `data-tiers` en la ficha), no como variaciones.
 * El agente no debe cobrar `cantidad × precio unitario`: descompone N en paquetes
 * eligiendo la combinación más barata que sume exactamente N unidades.
 */

import { OrderItem } from '../../commerce/domain/entities/Order.types';
import { normalizeProductText } from './productSelection.utils';

export interface PackTier {
  units: number;
  price: number;
}

export interface PackComponent {
  units: number;
  price: number;
  count: number;
}

export interface PackComposition {
  total: number;
  regularTotal: number;
  savings: number;
  savingsPercent: number;
  averageUnitPrice: number;
  components: PackComponent[];
}

export interface PackQuote {
  productId: number;
  sku: string;
  productName: string;
  unitLabel: string;
  unitPlural: string;
  desiredUnits: number;
  tiers: PackTier[];
  composition: PackComposition;
}

export interface PackUnitLabels {
  unitLabel: string;
  unitPlural: string;
}

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export function formatCop(value: number): string {
  return COP.format(Math.round(value));
}

export function normalizePackTiers(raw: unknown): PackTier[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;

  const tiers: PackTier[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const units = Number.parseInt(String(record.units ?? record.quantity ?? ''), 10);
    const price = Number.parseFloat(String(record.price ?? ''));
    if (!Number.isFinite(units) || units < 1 || !Number.isFinite(price) || price <= 0) continue;
    tiers.push({ units, price });
  }

  const unique = new Map<number, PackTier>();
  for (const tier of tiers) unique.set(tier.units, tier);
  const sorted = [...unique.values()].sort((a, b) => b.units - a.units);
  return sorted.length >= 2 ? sorted : null;
}

export function parsePackTiersFromMeta(
  metaData: Array<{ key?: string; value?: unknown }> | undefined
): PackTier[] | null {
  if (!metaData?.length) return null;

  for (const entry of metaData) {
    const direct = normalizePackTiers(entry.value);
    if (direct) return direct;

    if (typeof entry.value === 'string') {
      try {
        const fromJson = normalizePackTiers(JSON.parse(entry.value) as unknown);
        if (fromJson) return fromJson;
      } catch {
        /* ignore */
      }
    }
  }

  return null;
}

export function parsePackTiersFromHtml(html: string): PackTier[] | null {
  const match = html.match(/data-tiers="([^"]+)"/i);
  if (!match?.[1]) return null;
  const json = decodeHtmlEntities(match[1]);
  try {
    return normalizePackTiers(JSON.parse(json) as unknown);
  } catch {
    return null;
  }
}

export function parsePackUnitLabelsFromHtml(html: string): PackUnitLabels | null {
  const label = html.match(/data-unit-label="([^"]+)"/i)?.[1];
  const plural = html.match(/data-unit-plural="([^"]+)"/i)?.[1];
  if (!label && !plural) return null;
  return {
    unitLabel: decodeHtmlEntities(label ?? 'unidad'),
    unitPlural: decodeHtmlEntities(plural ?? `${label ?? 'unidad'}s`),
  };
}

export function inferPackUnitLabels(productName: string): PackUnitLabels {
  const normalized = normalizeProductText(productName);
  if (/balin/.test(normalized)) return { unitLabel: 'balín', unitPlural: 'balines' };
  if (/canutillo/.test(normalized)) return { unitLabel: 'canutillo', unitPlural: 'canutillos' };
  return { unitLabel: 'unidad', unitPlural: 'unidades' };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * Combinación más barata que suma exactamente `desired` unidades.
 * Empate: menos paquetes. Réplica del DP de `woo-massi`.
 */
export function composePacks(desired: number, tiers: PackTier[]): PackComposition | null {
  if (!Number.isFinite(desired) || desired < 1 || !tiers.length) return null;

  const max = Math.floor(desired);
  type Node = { cost: number; packs: number; counts: number[] };
  const best: Array<Node | undefined> = [{ cost: 0, packs: 0, counts: tiers.map(() => 0) }];

  for (let quantity = 1; quantity <= max; quantity += 1) {
    for (let index = 0; index < tiers.length; index += 1) {
      const tier = tiers[index]!;
      const previous = quantity - tier.units;
      const prevNode = previous >= 0 ? best[previous] : undefined;
      if (!prevNode) continue;

      const counts = [...prevNode.counts];
      counts[index] = (counts[index] ?? 0) + 1;
      const candidate: Node = {
        cost: prevNode.cost + tier.price,
        packs: prevNode.packs + 1,
        counts,
      };
      const current = best[quantity];
      const cheaper = !current || candidate.cost < current.cost - 0.00001;
      const sameCostFewerPacks =
        current &&
        Math.abs(candidate.cost - current.cost) < 0.00001 &&
        candidate.packs < current.packs;
      if (cheaper || sameCostFewerPacks) best[quantity] = candidate;
    }
  }

  const winner = best[max];
  if (!winner) return null;

  const unitTier = tiers.find((tier) => tier.units === 1);
  const regularTotal = unitTier ? unitTier.price * max : winner.cost;
  const savings = Math.max(0, regularTotal - winner.cost);
  const savingsPercent = regularTotal > 0 ? Math.round((savings / regularTotal) * 100) : 0;

  const components: PackComponent[] = [];
  for (let index = 0; index < tiers.length; index += 1) {
    const count = winner.counts[index] ?? 0;
    if (count < 1) continue;
    const tier = tiers[index]!;
    components.push({ units: tier.units, price: tier.price, count });
  }

  return {
    total: winner.cost,
    regularTotal,
    savings,
    savingsPercent,
    averageUnitPrice: winner.cost / max,
    components,
  };
}

export function packPackageTitle(
  units: number,
  count: number,
  labels: PackUnitLabels
): string {
  const capitalize = (value: string) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : value);
  if (units === 1) {
    return count > 1 ? `${count} ${capitalize(labels.unitPlural)}` : `1 ${capitalize(labels.unitLabel)}`;
  }
  const title = `Paquete X ${units} ${capitalize(labels.unitPlural)}`;
  return count > 1 ? `${count} × ${title}` : title;
}

export function formatPackQuoteMessage(quote: PackQuote): string {
  const { composition: result, desiredUnits, productName } = quote;
  const labels = { unitLabel: quote.unitLabel, unitPlural: quote.unitPlural };
  const unitWord = desiredUnits === 1 ? quote.unitLabel : quote.unitPlural;
  const lines: string[] = [
    `¡Aquí va tu cotización! 💎`,
    '',
    `Para *${desiredUnits} ${unitWord}* de *${productName}*, esta es la mejor combinación de paquetes:`,
    '',
  ];

  for (const component of result.components) {
    const title = packPackageTitle(component.units, component.count, labels);
    const subtotal = component.price * component.count;
    const each = component.count > 1 ? ` (${formatCop(component.price)} c/u)` : '';
    lines.push(`· ${title}${each} — *${formatCop(subtotal)}*`);
  }

  lines.push('');
  if (result.savings > 0) {
    lines.push(`Precio suelto: ~${formatCop(result.regularTotal)}~`);
    lines.push(
      `Ahorras *${result.savingsPercent}%* · ${formatCop(result.averageUnitPrice)} / und.`
    );
  }
  lines.push(`*Total: ${formatCop(result.total)}*`);
  lines.push('');
  lines.push('Todavía *no* lo agregué a tu pedido.');
  lines.push('Responde *sí* para sumarlo, o dime otra cantidad 🙂');
  return lines.join('\n');
}

export function formatPackQuantityPrompt(productName: string, labels: PackUnitLabels): string {
  return [
    `¡Listo! ✨ Encontré *${productName}*.`,
    '',
    `Se vende en *paquetes de 1, 2, 5 y 10* ${labels.unitPlural}.`,
    `Dime cuántos necesitas y te armo la combinación con el *mejor precio* 💎`,
  ].join('\n');
}

export function packQuoteToOrderItems(quote: PackQuote): OrderItem[] {
  const labels = { unitLabel: quote.unitLabel, unitPlural: quote.unitPlural };
  return quote.composition.components.map((component) => ({
    productId: quote.productId,
    sku: quote.sku,
    name: `${packPackageTitle(component.units, 1, labels)} · ${quote.productName}`,
    quantity: component.count,
    unitPrice: component.price,
    packUnits: component.units,
    packDesiredUnits: quote.desiredUnits,
  }));
}

/**
 * Cantidad de unidades que el cliente quiere de un producto a granel.
 * Ignora tallas (#10), medidas (10 mm) y SKUs (BAL-10DA).
 */
export function extractDesiredUnits(text: string): number | null {
  const stripped = text
    .replace(/\bpromo\s*x\s*\d+/gi, ' ')
    .replace(/\d+(?:[.,]\d+)?\s*[x×]\s*\d+(?:[.,]\d+)?/gi, ' ')
    .replace(/#\s*\d+/g, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:mm|cm|gr|g)\b/gi, ' ')
    .replace(/\b[A-Za-z]{2,}[A-Za-z0-9._-]*\d+[A-Za-z0-9._-]*\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/^\d{1,3}$/.test(stripped)) {
    const bare = Number.parseInt(stripped, 10);
    return bare >= 1 && bare <= 200 ? bare : null;
  }

  const withUnit = stripped.match(
    /\b(\d{1,3})\s*(?:unds?\.?|uds?\.?|unidades?|piezas?|pzs?|balines?|canutillos?|pares?)\b/i
  );
  if (withUnit) {
    const qty = Number.parseInt(withUnit[1]!, 10);
    return qty >= 1 && qty <= 200 ? qty : null;
  }

  const afterVerb = stripped.match(
    /\b(?:quiero|quisiera|gustaria|me\s+gustaria|dame|necesito|deseo|agrega(?:r)?|a[nñ]ade(?:r)?|pedir|llevo|son)\s+(\d{1,3})\b/i
  );
  if (afterVerb) {
    const qty = Number.parseInt(afterVerb[1]!, 10);
    return qty >= 1 && qty <= 200 ? qty : null;
  }

  return null;
}

export function isPackQuoteConfirmIntent(text: string): boolean {
  const t = normalizeProductText(text);
  if (extractDesiredUnits(text)) return false;
  return (
    /^(si|ok|okay|dale|va|perfecto|correcto|asi|agregalo|agregalos|agrega|anadelo|anade|anotalo|de una|me sirve|esa combinacion|quiero esa|asi esta|asi es)$/.test(
      t
    ) || /^(si|ok|dale),?\s*(agrega|anade|por favor|dale)/.test(t)
  );
}

/**
 * Verbo explícito de agregar («agrégalos», «sí, mételos al carrito»). A diferencia de
 * `isPackQuoteConfirmIntent`, tolera que el cliente repita la cantidad cotizada.
 */
export function isPackQuoteAddIntent(text: string): boolean {
  const t = normalizeProductText(text);
  // «agrega también una cadena» pide otro producto, no confirma la cotización.
  if (/\b(tambien|ademas|otro|otra|otros|otras)\b/.test(t)) return false;
  if (t.split(/\s+/).filter(Boolean).length > 8) return false;
  return /\b(agrega|agregalo|agregalos|agregame|agregamelo|agregamelos|anade|anadelo|anadelos|anademelos|sumalos|sumalo|metelos|metelo|ponlos|ponlo|echalos|anotalos|anotalo|los\s+quiero|lo\s+quiero|los\s+llevo|me\s+los\s+llevo|confirmo)\b/.test(
    t
  );
}

/**
 * «¿en cuánto me sale/cuánto cuestan N …?» — el cliente pide precio, no que se agregue.
 * Requiere cantidad: sin ella es una consulta de precio unitario y la resuelve el listado.
 */
export function isPackPriceQuestion(text: string): boolean {
  if (!extractDesiredUnits(text)) return false;
  const t = normalizeProductText(text);
  return /\b(?:cuanto|cuanta|cuantos|cuantas)\s+(?:me\s+|te\s+|nos\s+)?(?:sale|salen|saldria|saldrian|cuesta|cuestan|vale|valen|seria|serian|es|son)\b/.test(
    t
  ) ||
    /\ben\s+cuanto\b/.test(t) ||
    /\b(?:que|cual\s+es\s+el|cual\s+seria\s+el)\s+precio\b/.test(t) ||
    /\bprecio\s+(?:de|por)\b/.test(t) ||
    /\b(?:cotiza|cotizame|cotizar|cotizacion)\b/.test(t);
}

/** Cliente rechaza la cotización de paquetes (“no”, “cancelar”). */
export function isPackQuoteRejectIntent(text: string): boolean {
  const t = normalizeProductText(text);
  return /^(no|nop|nel|cancelar|cancela|olvidalo|mejor no)$/.test(t);
}

/** Deja solo la referencia al producto: «en cuánto me salen 18 balines #10» → «18 balines #10». */
export function stripPriceQuestionWords(text: string): string {
  return text
    .replace(
      /\b(?:en\s+cu[aá]nto|cu[aá]nto?s?|cu[aá]nta?s?|me|te|nos|sale|salen|saldr[ií]a|saldr[ií]an|cuesta|cuestan|vale|valen|ser[ií]a|ser[ií]an|qu[eé]\s+precio|precio|cot[ií]za(?:me)?|cotizar|cotizaci[oó]n)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export function isPackQuantityOnlyReply(text: string): boolean {
  if (!extractDesiredUnits(text)) return false;
  const t = text.trim();
  if (/^\d{1,3}$/.test(t)) return true;
  return /^(?:quiero|quisiera|gustaria|me\s+gustaria|dame|necesito|deseo|son|seran|serán)?\s*\d{1,3}\s*(?:unds?\.?|uds?\.?|unidades?|balines?|canutillos?|piezas?)?\s*\.?$/i.test(
    t
  );
}
