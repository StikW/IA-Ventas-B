import { describe, expect, it } from 'vitest';
import { WooCommerceProduct } from '../../woocommerce/domain/IWooCommerceService';
import { buildFamilyProductListMessage, formatDisplayPrice } from './productDisplay.utils';

function product(overrides: Partial<WooCommerceProduct> = {}): WooCommerceProduct {
  return {
    id: 1,
    name: 'Dije Virgen Milagrosa',
    sku: 'DJVMIL001',
    price: '267100',
    stockQuantity: 3,
    stockStatus: 'instock',
    description: '',
    status: 'publish',
    ...overrides,
  } as WooCommerceProduct;
}

describe('formatDisplayPrice', () => {
  it('formatea el precio en pesos', () => {
    expect(formatDisplayPrice('267100')).toBe('267.100');
    expect(formatDisplayPrice('$ 267.100')).toBe('267.100');
  });

  // Los plugins de precios de WooCommerce serializan `price` como número: antes reventaba
  // el listado entero y el cliente recibía el enlace genérico del catálogo.
  it('acepta el precio numérico que devuelven algunos plugins', () => {
    expect(formatDisplayPrice(267100 as unknown as string)).toBe('267.100');
  });

  it('no se cae cuando el producto no trae precio', () => {
    expect(formatDisplayPrice(null as unknown as string)).toBe('');
    expect(formatDisplayPrice(undefined as unknown as string)).toBe('');
  });
});

describe('buildFamilyProductListMessage', () => {
  // Los nombres de MASSI ya usan número (*Balín #6*, tallas): numerar las líneas hacía
  // ambiguo el "6" tanto para el cliente como para el agente.
  it('etiqueta las opciones con letras, no con números', () => {
    const message = buildFamilyProductListMessage(
      'balines',
      [
        product({ id: 1, name: 'Balín #3 Diamantado', sku: 'BLD3AM003', price: '13000' }),
        product({ id: 2, name: 'Balín #6 Diamantado', sku: 'BLD6AM006', price: '54400' }),
      ],
      19
    );

    expect(message).toContain('A) Balín #3 Diamantado');
    expect(message).toContain('B) Balín #6 Diamantado');
    expect(message).not.toContain('1. Balín');
    expect(message).toContain('Dime la *letra*');
  });

  it('marca el producto padre para abrir sus variantes por letra', () => {
    const message = buildFamilyProductListMessage(
      'dijes',
      [product({ name: 'Dije Trébol Mixto Doble Faz', sku: '', price: '218400' })],
      1
    );

    expect(message).toContain('varias opciones (dime A para verlas)');
  });

  it('lista los productos con su ID aunque el precio venga como número', () => {
    const message = buildFamilyProductListMessage(
      'virgen',
      [product({ price: 267100 as unknown as string })],
      1
    );

    expect(message).toContain('$267.100');
    expect(message).toContain('ID: *DJVMIL001*');
  });

  it('invita a pedir la ficha del producto', () => {
    const message = buildFamilyProductListMessage('virgen', [product()], 1);
    expect(message).toContain('*info*');
  });
});
