import { describe, expect, it } from 'vitest';
import { findOfferedOption, parseOptionReference } from './optionReference.utils';
import { OfferedOption } from './IChatSessionRepository';

describe('parseOptionReference', () => {
  it('resuelve ordinales en palabras', () => {
    expect(parseOptionReference('el primero', 8)).toEqual({ index: 0, quantity: 1 });
    expect(parseOptionReference('la segunda', 8)).toEqual({ index: 1, quantity: 1 });
    expect(parseOptionReference('quiero el tercero', 8)).toEqual({ index: 2, quantity: 1 });
  });

  it('resuelve la última opción sin conocer su posición', () => {
    expect(parseOptionReference('la ultima', 5)).toEqual({ index: 4, quantity: 1 });
    expect(parseOptionReference('el último', 3)).toEqual({ index: 2, quantity: 1 });
  });

  it('acepta la cantidad antes de la referencia', () => {
    expect(parseOptionReference('dos del primero', 4)).toEqual({ index: 0, quantity: 2 });
    expect(parseOptionReference('3 de la segunda', 4)).toEqual({ index: 1, quantity: 3 });
  });

  it('resuelve números que señalan la posición', () => {
    expect(parseOptionReference('2', 8)).toEqual({ index: 1, quantity: 1 });
    expect(parseOptionReference('el 3', 8)).toEqual({ index: 2, quantity: 1 });
    expect(parseOptionReference('opción 4', 8)).toEqual({ index: 3, quantity: 1 });
  });

  it('no inventa posiciones fuera del listado', () => {
    expect(parseOptionReference('el quinto', 3)).toBeNull();
    expect(parseOptionReference('9', 4)).toBeNull();
    expect(parseOptionReference('el primero', 0)).toBeNull();
  });

  it('ignora mensajes que no son referencias posicionales', () => {
    expect(parseOptionReference('CAD-ORO-45', 5)).toBeNull();
    expect(parseOptionReference('quiero una cadena de 45 cm', 5)).toBeNull();
    expect(parseOptionReference('finalizar pedido', 5)).toBeNull();
  });

  it('resuelve "qué opciones hay del 5" sobre el último listado', () => {
    expect(parseOptionReference('que opciones hay del 5?', 8)).toEqual({ index: 4, quantity: 1 });
    expect(parseOptionReference('opciones del 3', 8)).toEqual({ index: 2, quantity: 1 });
    expect(parseOptionReference('que opciones del numero 3?', 8)).toEqual({ index: 2, quantity: 1 });
  });

  it('respeta la cantidad al elegir por número', () => {
    expect(parseOptionReference('quiero dos del numero 7', 8)).toEqual({ index: 6, quantity: 2 });
    expect(parseOptionReference('quiero 2 del 7', 8)).toEqual({ index: 6, quantity: 2 });
    expect(parseOptionReference('tres de la opción 4', 8)).toEqual({ index: 3, quantity: 3 });
    expect(parseOptionReference('quiero dos unidades del 3', 8)).toEqual({ index: 2, quantity: 2 });
    expect(parseOptionReference('2 unidades de la 5', 8)).toEqual({ index: 4, quantity: 2 });
  });
});

describe('findOfferedOption', () => {
  const listed: OfferedOption[] = [
    { productId: 1, name: 'Anillo San Miguel Arcángel', sku: 'ANSM-01' },
    { productId: 2, name: 'Anillo Flor Bordada', variable: true },
    { productId: 3, name: 'Anillo Elefante', variable: true },
    { productId: 4, name: 'Anillo Dama Cuadrado Circones', variable: true },
    { productId: 5, name: 'Anillo Dama Desigual Diamantado con Circones', variable: true },
  ];

  it('prioriza el número aunque el mensaje pida opciones', () => {
    expect(findOfferedOption('que opciones hay del 5?', listed)).toEqual({ index: 4, quantity: 1 });
  });

  it('encuentra un producto padre por nombre', () => {
    expect(findOfferedOption('que opciones hay del anillo elefante?', listed)).toEqual({
      index: 2,
      quantity: 1,
    });
  });

  it('no adivina cuando el nombre no está en el listado', () => {
    expect(findOfferedOption('que opciones hay del anillo de oro rosa?', listed)).toBeNull();
  });
});
