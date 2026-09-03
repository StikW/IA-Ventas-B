import { describe, expect, it } from 'vitest';
import {
  extractListedProductNumber,
  findListedProductNumberAmbiguity,
  findOfferedOption,
  matchOfferedOptionByListedProductNumber,
  parseOptionReference,
} from './optionReference.utils';
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

  it('resuelve la letra con la que se etiquetan los listados', () => {
    expect(parseOptionReference('B', 8)).toEqual({ index: 1, quantity: 1 });
    expect(parseOptionReference('la c', 8)).toEqual({ index: 2, quantity: 1 });
    expect(parseOptionReference('opción D', 8)).toEqual({ index: 3, quantity: 1 });
    expect(parseOptionReference('de la h', 8)).toEqual({ index: 7, quantity: 1 });
    expect(parseOptionReference('Z', 8)).toBeNull();
  });

  it('resuelve la letra dentro de una frase de pedido, con o sin negrita de WhatsApp', () => {
    expect(parseOptionReference('quiero dos unidades del a', 2)).toEqual({ index: 0, quantity: 2 });
    expect(parseOptionReference('quiero dos unidades del *a*', 2)).toEqual({ index: 0, quantity: 2 });
    expect(parseOptionReference('agrega la b', 2)).toEqual({ index: 1, quantity: 1 });
    expect(parseOptionReference('2 unidades de la a', 2)).toEqual({ index: 0, quantity: 2 });
  });

  // Un "6" tras listar *Balín #6* casi nunca es la sexta línea: es el producto.
  it('descarta el dígito suelto cuando los nombres del listado llevan número', () => {
    const balines = [{ name: 'Balín #3 Diamantado' }, { name: 'Balín #6 Diamantado' }];
    expect(parseOptionReference('6', 2, balines)).toBeNull();
    expect(parseOptionReference('el 2', 2, balines)).toBeNull();
    expect(parseOptionReference('B', 2, balines)).toEqual({ index: 1, quantity: 1 });
    expect(parseOptionReference('el primero', 2, balines)).toEqual({ index: 0, quantity: 1 });
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

  it('reconoce el ID que el cliente reenvía, con o sin la negrita de WhatsApp', () => {
    expect(findOfferedOption('ANSM-01', listed)).toEqual({ index: 0, quantity: 1 });
    expect(findOfferedOption('quiero el *ANSM-01*', listed)).toEqual({ index: 0, quantity: 1 });
  });

  it('elige por letra o ID del último listado aunque vayan en una frase', () => {
    const variants: OfferedOption[] = [
      { productId: 10, name: 'Dije Corona Mateada - 10 x 10 mm', sku: 'DCOMAT002' },
      { productId: 10, name: 'Dije Corona Mateada - 12 x 12 mm', sku: 'DCOMAT001' },
    ];
    expect(findOfferedOption('quiero dos unidades del a', variants)).toEqual({ index: 0, quantity: 2 });
    expect(findOfferedOption('quiero dos unidades del *a*', variants)).toEqual({ index: 0, quantity: 2 });
    expect(findOfferedOption('quiero dos unidades del dcomat002', variants)).toEqual({
      index: 0,
      quantity: 2,
    });
    expect(findOfferedOption('quiero dos unidades del *DCOMAT002*', variants)).toEqual({
      index: 0,
      quantity: 2,
    });
  });

  it('no usa el nombre del listado cuando se pide una familia distinta', () => {
    expect(findOfferedOption('tienen anillos?', listed, { allowNameMatch: false })).toBeNull();
  });
});

const balinesListed: OfferedOption[] = [
  { productId: 1, name: 'Balín #3 Diamantado Oro Nacional Amarillo', sku: 'BLD3AM003' },
  { productId: 2, name: 'Balín #4 Diamantado Oro Nacional Amarillo', sku: 'BLD4AM004' },
  { productId: 3, name: 'Balín #5 Liso Oro Nacional Amarillo', sku: 'BLL5AM005' },
  { productId: 4, name: 'Balín #5 Diamantado Oro Nacional Amarillo', sku: 'BLD5AM005' },
  { productId: 5, name: 'Balín #6 Diamantado Oro Nacional Amarillo', sku: 'BLD6AM006' },
];

describe('matchOfferedOptionByListedProductNumber', () => {
  it('resuelve #N contra el último listado con cantidad', () => {
    expect(extractListedProductNumber('quisiera 4 unidades del #3')).toBe('3');
    expect(matchOfferedOptionByListedProductNumber('quisiera 4 unidades del #3', balinesListed)).toEqual({
      index: 0,
      quantity: 4,
    });
    expect(findOfferedOption('quisiera 4 unidades del #3', balinesListed)).toEqual({
      index: 0,
      quantity: 4,
    });
  });

  it('acepta "del 3" sin numeral cuando hay unidades', () => {
    expect(matchOfferedOptionByListedProductNumber('4 unidades del 3', balinesListed)).toEqual({
      index: 0,
      quantity: 4,
    });
  });

  it('no adivina cuando hay varios #5 en el listado', () => {
    expect(matchOfferedOptionByListedProductNumber('quiero 2 del #5', balinesListed)).toBeNull();
    expect(findListedProductNumberAmbiguity('quiero 2 del #5', balinesListed)).toEqual([2, 3]);
  });

  it('no confunde #3 del listado con la posición 3 del listado', () => {
    expect(parseOptionReference('quisiera 4 unidades del #3', balinesListed.length, balinesListed)).toBeNull();
    expect(findOfferedOption('quisiera 4 unidades del #3', balinesListed)).toEqual({
      index: 0,
      quantity: 4,
    });
  });
});
