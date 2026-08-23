import { describe, expect, it } from 'vitest';
import { resolveBbcUiRoute } from './bbcUiRoute';
import { WA_BTN, WA_BTN_LABEL } from './whatsappFlow.constants';
import { CATALOG_CTA_LABEL } from './catalogUrl.utils';

describe('resolveBbcUiRoute', () => {
  it('prioriza cart cuando hay botón vaciar carrito', () => {
    expect(
      resolveBbcUiRoute({
        kind: 'buttons',
        body: 'Resumen',
        buttons: [
          { id: WA_BTN.CART_FINALIZE, body: WA_BTN_LABEL.CART_FINALIZE },
          { id: WA_BTN.CART_CLEAR, body: WA_BTN_LABEL.CART_CLEAR },
        ],
      })
    ).toBe('cart');
  });

  it('usa finalize cuando solo hay botón finalizar pedido', () => {
    expect(
      resolveBbcUiRoute({
        kind: 'buttons',
        body: 'Resumen',
        buttons: [{ id: WA_BTN.CART_FINALIZE, body: WA_BTN_LABEL.CART_FINALIZE }],
      })
    ).toBe('finalize');
  });

  it('usa catalog cuando hay CTA de catálogo', () => {
    expect(
      resolveBbcUiRoute({
        kind: 'cta_url',
        body: 'Mira el catálogo',
        displayText: CATALOG_CTA_LABEL,
        url: 'https://tienda.example/tienda/',
      })
    ).toBe('catalog');
  });

  it('devuelve none para texto plano', () => {
    expect(resolveBbcUiRoute({ kind: 'text', body: 'Hola' })).toBe('none');
  });
});
