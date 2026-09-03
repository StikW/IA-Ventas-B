import { describe, expect, it } from 'vitest';
import { encodeCheckoutItems, parseCheckoutItems } from './checkoutLink.utils';
import { PendingCartItem } from './IChatSessionRepository';

describe('encodeCheckoutItems', () => {
  it('codifica cada paquete woo-massi por tamaño y cantidad de paquetes', () => {
    const items: PendingCartItem[] = [
      {
        productId: 1915,
        sku: 'BAL-10DA',
        name: 'Paquete X 10 Balines',
        quantity: 1,
        unitPrice: 1_720_000,
        packUnits: 10,
      },
      {
        productId: 1915,
        sku: 'BAL-10DA',
        name: 'Paquete X 5 Balines',
        quantity: 1,
        unitPrice: 870_000,
        packUnits: 5,
      },
      {
        productId: 1915,
        sku: 'BAL-10DA',
        name: 'Paquete X 2 Balines',
        quantity: 1,
        unitPrice: 355_000,
        packUnits: 2,
      },
      {
        productId: 1915,
        sku: 'BAL-10DA',
        name: '1 Balín',
        quantity: 1,
        unitPrice: 180_000,
        packUnits: 1,
      },
    ];
    expect(encodeCheckoutItems(items)).toBe('BAL-10DAx10:1,BAL-10DAx5:1,BAL-10DAx2:1,BAL-10DAx1:1');
  });

  it('refleja el carrito real del agente (3×10 + 2×2 + producto simple)', () => {
    const items: PendingCartItem[] = [
      {
        productId: 1,
        sku: 'BLD6AM006',
        name: 'Paquete X 10 Balines · Balín #6',
        quantity: 3,
        unitPrice: 518_000,
        packUnits: 10,
        packDesiredUnits: 34,
      },
      {
        productId: 1,
        sku: 'BLD6AM006',
        name: 'Paquete X 2 Balines · Balín #6',
        quantity: 2,
        unitPrice: 106_200,
        packUnits: 2,
        packDesiredUnits: 34,
      },
      {
        productId: 2,
        sku: 'DJVMIL004',
        name: 'Dije Virgen Milagrosa con Estrellas',
        quantity: 1,
        unitPrice: 274_700,
      },
    ];
    expect(encodeCheckoutItems(items)).toBe('BLD6AM006x10:3,BLD6AM006x2:2,DJVMIL004:1');
  });

  it('deja los productos simples como SKU:qty', () => {
    expect(
      encodeCheckoutItems([
        { productId: 1, sku: 'CAD-ORO-45', name: 'Cadena 45', quantity: 2, unitPrice: 100 },
      ])
    ).toBe('CAD-ORO-45:2');
  });
});

describe('parseCheckoutItems', () => {
  it('entiende el formato nuevo SKUxN:qty', () => {
    expect(parseCheckoutItems('BLLSAM005x10:1,BLLSAM005x5:1')).toEqual([
      { sku: 'BLLSAM005', qty: 1, packUnits: 10 },
      { sku: 'BLLSAM005', qty: 1, packUnits: 5 },
    ]);
  });

  it('entiende el -- que deja WhatsApp al tachar ~', () => {
    expect(parseCheckoutItems('BLLSAM005--10:1,BLLSAM005--5:1')).toEqual([
      { sku: 'BLLSAM005', qty: 1, packUnits: 10 },
      { sku: 'BLLSAM005', qty: 1, packUnits: 5 },
    ]);
  });

  it('sigue aceptando el formato histórico con ~', () => {
    expect(parseCheckoutItems('BLD6AM006~10:3,BLD6AM006~2:2,DJVMIL004:1')).toEqual([
      { sku: 'BLD6AM006', qty: 3, packUnits: 10 },
      { sku: 'BLD6AM006', qty: 2, packUnits: 2 },
      { sku: 'DJVMIL004', qty: 1 },
    ]);
  });

  it('no trata un SKU con guiones como paquete', () => {
    expect(parseCheckoutItems('CAD-ORO-45:2')).toEqual([{ sku: 'CAD-ORO-45', qty: 2 }]);
  });

  it('reconstruye comas si WhatsApp las cambió por puntos', () => {
    expect(parseCheckoutItems('BLLSAM005x10:1.BLLSAM005x5:1')).toEqual([
      { sku: 'BLLSAM005', qty: 1, packUnits: 10 },
      { sku: 'BLLSAM005', qty: 1, packUnits: 5 },
    ]);
  });
});
