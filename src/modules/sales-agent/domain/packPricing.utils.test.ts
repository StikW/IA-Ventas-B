import { describe, expect, it } from 'vitest';
import {
  composePacks,
  extractDesiredUnits,
  formatPackQuoteMessage,
  inferPackUnitLabels,
  isPackPriceQuestion,
  isPackQuantityOnlyReply,
  isPackQuoteAddIntent,
  isPackQuoteConfirmIntent,
  isPackQuoteRejectIntent,
  normalizePackTiers,
  packQuoteToOrderItems,
  parsePackTiersFromHtml,
  parsePackTiersFromMeta,
  stripPriceQuestionWords,
  type PackQuote,
} from './packPricing.utils';

const BAL10_TIERS = [
  { units: 10, price: 1_720_000 },
  { units: 5, price: 870_000 },
  { units: 2, price: 355_000 },
  { units: 1, price: 180_000 },
];

const BAL3_TIERS = [
  { units: 10, price: 125_000 },
  { units: 5, price: 65_000 },
  { units: 2, price: 26_600 },
  { units: 1, price: 13_600 },
];

describe('composePacks', () => {
  it('arma 18 unidades del balín #10 con un paquete de cada tamaño', () => {
    const result = composePacks(18, BAL10_TIERS);
    expect(result).not.toBeNull();
    expect(result!.components).toEqual([
      { units: 10, price: 1_720_000, count: 1 },
      { units: 5, price: 870_000, count: 1 },
      { units: 2, price: 355_000, count: 1 },
      { units: 1, price: 180_000, count: 1 },
    ]);
    expect(result!.total).toBe(3_125_000);
    expect(result!.regularTotal).toBe(3_240_000);
    expect(result!.savingsPercent).toBe(4);
  });

  it('arma 18 unidades del balín #3 liso con los precios de paquetes', () => {
    const result = composePacks(18, BAL3_TIERS);
    expect(result!.total).toBe(230_200);
    expect(result!.regularTotal).toBe(244_800);
  });

  it('usa varios paquetes iguales cuando hace falta (20 = 2×10)', () => {
    const result = composePacks(20, BAL10_TIERS);
    expect(result!.components).toEqual([{ units: 10, price: 1_720_000, count: 2 }]);
    expect(result!.total).toBe(3_440_000);
  });

  it('devuelve un solo balín si piden 1', () => {
    const result = composePacks(1, BAL10_TIERS);
    expect(result!.components).toEqual([{ units: 1, price: 180_000, count: 1 }]);
    expect(result!.total).toBe(180_000);
    expect(result!.savings).toBe(0);
  });
});

describe('extractDesiredUnits', () => {
  it('lee 18 und / 18 balines y no confunde el #10', () => {
    expect(extractDesiredUnits('quiero 18 und de balín #10 diamantado')).toBe(18);
    expect(extractDesiredUnits('quiero 18 balines #10 diamantados')).toBe(18);
    expect(extractDesiredUnits('18')).toBe(18);
    expect(extractDesiredUnits('BAL-10DA')).toBeNull();
    expect(extractDesiredUnits('quiero balín #10 diamantado')).toBeNull();
  });
});

describe('parsePackTiersFromHtml / meta', () => {
  it('lee data-tiers del HTML de la ficha', () => {
    const html =
      'data-tiers="[{&quot;units&quot;:10,&quot;price&quot;:1720000},{&quot;units&quot;:5,&quot;price&quot;:870000},{&quot;units&quot;:2,&quot;price&quot;:355000},{&quot;units&quot;:1,&quot;price&quot;:180000}]"';
    expect(parsePackTiersFromHtml(html)).toEqual(BAL10_TIERS);
  });

  it('lee meta de WooCommerce con el array de paquetes', () => {
    const tiers = parsePackTiersFromMeta([
      { key: '_wm_promotion_tiers', value: BAL10_TIERS },
    ]);
    expect(tiers).toEqual(BAL10_TIERS);
  });

  it('rechaza un meta que no es lista de paquetes', () => {
    expect(parsePackTiersFromMeta([{ key: '_sku', value: 'BAL-10DA' }])).toBeNull();
  });
});

describe('pack quote → carrito', () => {
  it('genera una línea por tamaño de paquete', () => {
    const composition = composePacks(18, BAL10_TIERS)!;
    const quote: PackQuote = {
      productId: 1915,
      sku: 'BAL-10DA',
      productName: 'Balín #10 Diamantado',
      unitLabel: 'balín',
      unitPlural: 'balines',
      desiredUnits: 18,
      tiers: BAL10_TIERS,
      composition,
    };
    const items = packQuoteToOrderItems(quote);
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.packUnits)).toEqual([10, 5, 2, 1]);
    expect(items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)).toBe(3_125_000);
    expect(formatPackQuoteMessage(quote)).toContain('¡Aquí va tu cotización!');
    expect(formatPackQuoteMessage(quote)).toContain('*Total:');
    expect(inferPackUnitLabels('Balín-Diamantado-#10')).toEqual({
      unitLabel: 'balín',
      unitPlural: 'balines',
    });
  });
});

describe('confirm / reject de la cotización', () => {
  it('reconoce sí / agrégalo y no / cancelar', () => {
    expect(isPackQuoteConfirmIntent('sí')).toBe(true);
    expect(isPackQuoteConfirmIntent('agrégalo')).toBe(true);
    expect(isPackQuoteRejectIntent('no')).toBe(true);
    expect(isPackQuoteConfirmIntent('quiero 20')).toBe(false);
    expect(isPackQuantityOnlyReply('18')).toBe(true);
    expect(isPackQuantityOnlyReply('quiero 18')).toBe(true);
    expect(isPackQuantityOnlyReply('quisiera 18 balines')).toBe(true);
    expect(isPackQuantityOnlyReply('me gustaria 25')).toBe(true);
    expect(isPackQuantityOnlyReply('quiero 18 balines #10')).toBe(false);
  });

  it('acepta el verbo de agregar aunque el cliente repita la cantidad', () => {
    expect(isPackQuoteAddIntent('sí, agrégame los 18')).toBe(true);
    expect(isPackQuoteAddIntent('agrégalos al carrito')).toBe(true);
    expect(isPackQuoteAddIntent('los quiero')).toBe(true);
  });

  it('no confunde pedir otro producto con confirmar', () => {
    expect(isPackQuoteAddIntent('agrega también una cadena de oro')).toBe(false);
    expect(isPackQuoteAddIntent('quiero otra cosa')).toBe(false);
  });
});

describe('isPackPriceQuestion', () => {
  it('detecta la consulta de precio por cantidad', () => {
    expect(isPackPriceQuestion('en cuánto me salen 18 balines #10')).toBe(true);
    expect(isPackPriceQuestion('cuánto cuestan 12 balines diamantados')).toBe(true);
    expect(isPackPriceQuestion('cuánto valen 7 unidades del balín #6')).toBe(true);
    expect(isPackPriceQuestion('qué precio tienen 20 balines')).toBe(true);
    expect(isPackPriceQuestion('cotízame 15 balines #4')).toBe(true);
  });

  it('ignora consultas sin cantidad o sin pregunta de precio', () => {
    expect(isPackPriceQuestion('cuánto vale el balín #6')).toBe(false);
    expect(isPackPriceQuestion('quiero 18 balines #10')).toBe(false);
    expect(isPackPriceQuestion('tienen balines')).toBe(false);
  });

  it('deja solo la referencia al producto', () => {
    expect(stripPriceQuestionWords('en cuánto me salen 18 balines #10')).toBe('18 balines #10');
    expect(stripPriceQuestionWords('cuánto cuestan 12 balines diamantados')).toBe('12 balines diamantados');
    expect(stripPriceQuestionWords('cotízame 15 balines #4')).toBe('15 balines #4');
  });
});

describe('normalizePackTiers', () => {
  it('pide al menos dos tamaños', () => {
    expect(normalizePackTiers([{ units: 1, price: 100 }])).toBeNull();
  });
});
