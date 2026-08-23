import { describe, expect, it } from 'vitest';
import { isProductSelectionIntent } from './whatsappFlow.constants';

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
