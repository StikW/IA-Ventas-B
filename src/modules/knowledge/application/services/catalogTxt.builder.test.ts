import { describe, expect, it } from 'vitest';
import {
  buildCatalogTxt,
  formatCatalogIssuesReport,
  type CatalogTxtProduct,
  type CatalogTxtVariation,
} from './catalogTxt.builder';

function simpleProduct(overrides: Partial<CatalogTxtProduct> = {}): CatalogTxtProduct {
  return {
    id: 1,
    name: 'Balín Diamantado 6 mm',
    sku: 'BLD6AM001',
    type: 'simple',
    status: 'publish',
    price: '12000',
    short_description: 'Balín de 6 mm',
    stock_status: 'instock',
    categories: [{ id: 10, name: 'Balines' }],
    tags: [{ id: 3, name: 'oro' }],
    attributes: [],
    meta_data: [],
    ...overrides,
  };
}

function variableProduct(): CatalogTxtProduct {
  return simpleProduct({
    id: 2,
    name: 'Cadena oro 45 cm',
    sku: '',
    type: 'variable',
    short_description: '',
    categories: [{ id: 11, name: 'Cadenas' }],
    tags: [],
    attributes: [{ name: 'Largo', options: ['45 cm', '50 cm'] }],
  });
}

describe('buildCatalogTxt', () => {
  it('emite un bloque simple con SKU, categoría y paquetes woo-massi', () => {
    const result = buildCatalogTxt(
      [
        {
          product: simpleProduct({
            meta_data: [
              { key: '_wm_promo_unit_plural', value: 'balines' },
              {
                key: '_wm_tiers',
                value: [
                  { units: 10, price: 80000 },
                  { units: 1, price: 12000 },
                ],
              },
            ],
          }),
          variations: [],
        },
      ],
      { generatedAt: new Date('2026-09-18T00:00:00.000Z') }
    );

    expect(result.stats).toEqual({ productCount: 1, skuCount: 1, packCount: 1 });
    expect(result.text).toContain('# Generado desde WooCommerce el 2026-09-18');
    expect(result.text).toContain('Producto: Balín Diamantado 6 mm');
    expect(result.text).toContain('SKU: BLD6AM001');
    expect(result.text).toContain('Categoría: Balines');
    expect(result.text).toContain('Etiquetas: oro');
    expect(result.text).toContain('Paquetes: 1, 10 balines');
    expect(result.text).toContain('Milímetros: 6');
    expect(result.issues).toEqual([]);
  });

  it('lista variaciones con SKU y omite las que no tienen SKU', () => {
    const variations: CatalogTxtVariation[] = [
      { id: 21, sku: 'CAD-45', price: '80000', stock_status: 'instock', attributes: [{ name: 'Largo', option: '45 cm' }] },
      { id: 22, sku: '', price: '90000', stock_status: 'instock', attributes: [{ name: 'Largo', option: '50 cm' }] },
    ];

    const result = buildCatalogTxt([{ product: variableProduct(), variations }]);

    expect(result.stats.skuCount).toBe(1);
    expect(result.text).toContain('SKU: CAD-45');
    expect(result.text).toContain('Variaciones: 45 cm');
    expect(result.issues.some((issue) => issue.kind === 'Variaciones sin SKU')).toBe(true);
  });

  it('omite productos sin SKU y reporta inconsistencias de catálogo', () => {
    const result = buildCatalogTxt([
      { product: simpleProduct({ sku: '' }), variations: [] },
      { product: simpleProduct({ id: 3, name: 'Balín Diamantado 6 mm', sku: 'OTRO' }), variations: [] },
    ]);

    expect(result.stats.productCount).toBe(1);
    expect(result.issues.some((issue) => issue.kind === 'Sin SKU: el agente no puede venderlo')).toBe(true);
    expect(result.issues.some((issue) => issue.kind === 'Nombre duplicado')).toBe(true);
    expect(formatCatalogIssuesReport(result.issues)).toContain('Inconsistencias detectadas');
  });
});
