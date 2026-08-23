import { describe, expect, it } from 'vitest';
import {
  findBestCartMatch,
  isCartClearIntent,
  isCartCorrectionIntent,
  isCartIncrementIntent,
  isCartKeepOnlyIntent,
  isCartRejectIntent,
  isCartRemoveIntent,
  isCartReviewIntent,
  isCartSetQuantityIntent,
  isVagueCartTarget,
  parseCartKeepOnly,
  parseCartRemove,
  splitCartEditClauses,
} from './cartModification.utils';
import { PendingCartItem } from './IChatSessionRepository';

describe('isCartKeepOnlyIntent', () => {
  it('reconoce que el cliente redefine el carrito completo', () => {
    expect(
      isCartKeepOnlyIntent('solo quiero la cadena lazo de 45cm y el anillo dama flor con circones 7 1/2 verde')
    ).toBe(true);
    expect(isCartKeepOnlyIntent('no quiero todo el carrito, solo los dos productos que te dije anteriormente')).toBe(
      true
    );
    expect(isCartKeepOnlyIntent('quiero solamente la cadena de 45')).toBe(true);
  });

  it('no se activa con preguntas', () => {
    expect(isCartKeepOnlyIntent('solo quiero saber el precio de la cadena')).toBe(false);
    expect(isCartKeepOnlyIntent('¿solo tienen esa opción?')).toBe(false);
  });

  it('no se activa cuando el cliente quita algo puntual', () => {
    expect(isCartKeepOnlyIntent('solo quiero quitar la cadena de 60')).toBe(false);
    expect(isCartKeepOnlyIntent('vaciar carrito')).toBe(false);
  });

  it('no se confunde con ajustar cantidad', () => {
    expect(isCartKeepOnlyIntent('deja solo 2 balines')).toBe(false);
    expect(isCartSetQuantityIntent('deja solo 2 balines')).toBe(true);
  });
});

describe('convivencia con las demás intenciones de carrito', () => {
  it('una corrección puntual sigue siendo corrección, no redefinición', () => {
    const text = 'no quiero las de 50cm, solo una de 45cm';
    expect(isCartKeepOnlyIntent(text)).toBe(false);
    expect(isCartCorrectionIntent(text)).toBe(true);
  });

  it('redefinir el carrito no se trata como corrección ni como eliminación', () => {
    const text = 'no quiero todo el carrito, solo los dos productos que te dije anteriormente';
    expect(isCartCorrectionIntent(text)).toBe(false);
    expect(isCartRemoveIntent(text)).toBe(false);
    expect(isCartClearIntent(text)).toBe(false);
  });
});

describe('parseCartKeepOnly', () => {
  it('extrae los productos que el cliente quiere conservar', () => {
    expect(parseCartKeepOnly('solo quiero la cadena lazo de 45cm y el anillo talla 7')).toEqual({
      wanted: 'la cadena lazo de 45cm y el anillo talla 7',
      previousReference: false,
    });
  });

  it('marca las referencias a lo pedido antes en vez de buscarlas en el catálogo', () => {
    expect(parseCartKeepOnly('no quiero todo el carrito, solo los dos productos que te dije anteriormente')).toEqual({
      wanted: 'los dos productos que te dije anteriormente',
      previousReference: true,
    });
  });
});

describe('isCartReviewIntent', () => {
  it('detecta que el cliente solo quiere ver el resumen', () => {
    expect(isCartReviewIntent('como va mi carrito?')).toBe(true);
    expect(isCartReviewIntent('qué hay en el carrito')).toBe(true);
    expect(isCartReviewIntent('ver mi carrito')).toBe(true);
  });

  it('no se confunde con vaciar o redefinir el carrito', () => {
    expect(isCartReviewIntent('vaciar carrito')).toBe(false);
    expect(isCartReviewIntent('solo quiero la cadena de 45')).toBe(false);
  });
});

describe('rechazo y ajuste del carrito', () => {
  const cart: PendingCartItem[] = [
    {
      productId: 1,
      sku: 'DJ-VMI-ETR1',
      name: 'Dije Virgen Milagrosa Estriada',
      quantity: 1,
      unitPrice: 340000,
    },
    {
      productId: 2,
      sku: 'DJCZBR-8X8',
      name: 'Dije Corazón Casting',
      quantity: 1,
      unitPrice: 503000,
    },
  ];

  it('trata "ya no quiero" como quitar del carrito, no como catálogo', () => {
    const text = 'ya no quiero el dije de corazón';
    expect(isCartRejectIntent(text)).toBe(true);
    expect(isCartRemoveIntent(text)).toBe(true);
    expect(isCartCorrectionIntent(text)).toBe(false);
    expect(findBestCartMatch(cart, parseCartRemove(text).target)?.sku).toBe('DJCZBR-8X8');
  });

  it('parte el mensaje cuando quita uno y pide otra unidad de otro', () => {
    const text = 'ya no quiero el dije de corazón y quiero otra unidad del dije de la virgen';
    expect(isCartRemoveIntent(text)).toBe(true);
    expect(isCartIncrementIntent(text)).toBe(false);

    const clauses = splitCartEditClauses(text);
    expect(clauses.reject).toMatch(/corazón/i);
    expect(clauses.want).toMatch(/virgen/i);
    expect(findBestCartMatch(cart, parseCartRemove(clauses.reject).target)?.sku).toBe('DJCZBR-8X8');
  });

  it('detecta "otra unidad" sobre un ítem del carrito', () => {
    expect(isCartIncrementIntent('quiero otra unidad del dije de la virgen')).toBe(true);
    expect(isCartRemoveIntent('quiero otra unidad del dije de la virgen')).toBe(false);
  });
});

describe('isVagueCartTarget', () => {
  it('detecta referencias al carrito entero o a algo dicho antes', () => {
    expect(isVagueCartTarget('todo el carrito')).toBe(true);
    expect(isVagueCartTarget('los productos que te dije anteriormente')).toBe(true);
    expect(isVagueCartTarget('lo mismo')).toBe(true);
  });

  it('no marca como vago un producto concreto', () => {
    expect(isVagueCartTarget('la cadena lazo de 45 cm')).toBe(false);
    expect(isVagueCartTarget('CAD-ORO-45')).toBe(false);
  });
});
