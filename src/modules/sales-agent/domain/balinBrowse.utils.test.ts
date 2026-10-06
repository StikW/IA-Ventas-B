import { describe, expect, it } from 'vitest';
import { WooCommerceProduct } from '../../woocommerce/domain/IWooCommerceService';
import { planBalinFamilyBrowse } from './balinBrowse.utils';

function balin(id: number, name: string, sku: string): WooCommerceProduct {
  return {
    id,
    name,
    sku,
    price: '13000',
    stockQuantity: 10,
    stockStatus: 'instock',
    description: '',
    status: 'publish',
    type: 'simple',
    categories: [{ id: 1, name: 'Diamantado' }],
  } as WooCommerceProduct;
}

const CATALOG = [
  balin(1, 'Balín #8 Diamantado Oro Nacional Amarillo', 'BLD8AM008'),
  balin(2, 'Balín #3 Diamantado Oro Nacional Amarillo', 'BLD3AM003'),
  balin(3, 'Balín #10 Diamantado Oro Nacional Amarillo', 'BAL-10DA'),
  balin(4, 'Balín #4 Liso Oro Nacional Amarillo', 'BLL4AM004'),
  balin(5, 'Balín #3 Liso Oro Nacional Amarillo', 'BLL3AM003'),
  balin(6, 'Balín #5 Diamantado Oro Nacional Rosa', 'BLD5RO001'),
  balin(7, 'Balín #3 Diamantado Oro Nacional Rosa', 'BLD3RO006'),
  balin(8, 'Balín #5 Liso Oro Nacional Amarillo', 'BLL5AM005'),
  balin(9, 'Balín #5 Diamantado Oro Nacional Amarillo', 'BLD5AM005'),
];

describe('planBalinFamilyBrowse', () => {
  it('agrupa una pregunta general por acabado y oro, no por tamaño', () => {
    const plan = planBalinFamilyBrowse(CATALOG, 'quiero balines', 'balines');
    expect(plan.kind).toBe('types');
    if (plan.kind !== 'types') return;

    expect(plan.message).toContain('tipos de *balines*');
    expect(plan.message).not.toContain('BLD3AM003');
    expect(plan.options.map((option) => option.name)).toEqual([
      'Balín Diamantado Oro Nacional Amarillo',
      'Balín Liso Oro Nacional Amarillo',
      'Balín Diamantado Oro Nacional Rosa',
    ]);
    expect(plan.options[0]?.sku).toBeUndefined();
    expect(plan.options[0]?.memberProductIds).toEqual([2, 9, 1, 3]);
    expect(plan.options[1]?.memberProductIds).toEqual([5, 4, 8]);
  });

  it('al nombrar un tipo lista solo sus tamaños, del menor al mayor', () => {
    const plan = planBalinFamilyBrowse(CATALOG, 'balines lisos oro amarillo', 'balin');
    expect(plan.kind).toBe('sizes');
    if (plan.kind !== 'sizes') return;

    expect(plan.label).toBe('Balín Liso Oro Nacional Amarillo');
    expect(plan.products.map((product) => product.sku)).toEqual(['BLL3AM003', 'BLL4AM004', 'BLL5AM005']);
  });

  it('un # concreto lista ese número en todos los tipos', () => {
    const plan = planBalinFamilyBrowse(CATALOG, 'tienen balines #5', 'balines');
    expect(plan.kind).toBe('sizes');
    if (plan.kind !== 'sizes') return;

    expect(plan.label).toBe('Balín #5');
    expect(plan.products.map((product) => product.sku).sort()).toEqual([
      'BLD5AM005',
      'BLD5RO001',
      'BLL5AM005',
    ]);
  });

  it('no agrupa otras familias', () => {
    const plan = planBalinFamilyBrowse(
      [balin(1, 'Cadena Oro 45', 'CAD-45'), balin(2, 'Cadena Oro 50', 'CAD-50')],
      'tienen cadenas',
      'cadena'
    );
    expect(plan.kind).toBe('default');
  });
});
