import { describe, expect, it } from 'vitest';
import { isCartContinueShoppingIntent, isProductSelectionIntent } from './whatsappFlow.constants';

describe('isProductSelectionIntent', () => {
  it('no trata una pregunta de disponibilidad como pedido', () => {
    expect(isProductSelectionIntent('Tienen balines #4')).toBe(false);
    expect(isProductSelectionIntent('hay anillos talla 6?')).toBe(false);
  });

  it('sigue agregando cuando el cliente pide el producto', () => {
    expect(isProductSelectionIntent('quiero balín #4')).toBe(true);
    expect(isProductSelectionIntent('BAL-4LA')).toBe(true);
  });
});

describe('isCartContinueShoppingIntent', () => {
  it('no se come una elección del listado como "agregar algo más"', () => {
    expect(isCartContinueShoppingIntent('agrega el a')).toBe(false);
    expect(isCartContinueShoppingIntent('agregar B')).toBe(false);
    expect(isCartContinueShoppingIntent('quiero dos unidades del a')).toBe(false);
  });

  it('sigue reconociendo el "quiero agregar más" genérico', () => {
    expect(isCartContinueShoppingIntent('algo más')).toBe(true);
    expect(isCartContinueShoppingIntent('sí, algo más')).toBe(true);
  });
});
