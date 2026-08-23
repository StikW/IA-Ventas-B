import { describe, expect, it } from 'vitest';
import {
  extractAllVariantHints,
  extractProductFamilyTerm,
  extractQuantityFromText,
  extractVariantHint,
  hasConcreteProductSpec,
  isAvailabilityQuestion,
  isCatalogBrowseIntent,
  isDirectVariantAddIntent,
  isProductFamilyBrowseIntent,
  isProductOptionsBrowseIntent,
  isThemeBrowseIntent,
  registerCatalogFamilyTerms,
  themeListLabel,
  variantHintsMatch,
} from './productSelection.utils';

describe('extractVariantHint', () => {
  it('captura la dimensión completa y no solo la última medida', () => {
    expect(extractVariantHint('el de 10 x 9 mm')).toBe('10 x 9 mm');
  });

  it('acepta el signo × que usa WooCommerce en los atributos', () => {
    expect(extractVariantHint('quiero el de 8 × 7 mm')).toBe('8 × 7 mm');
  });

  it('captura tallas fraccionarias', () => {
    expect(extractVariantHint('anillo talla 7 1/2')).toBe('7 1/2');
    expect(extractVariantHint('talla 10 1/4')).toBe('10 1/4');
  });

  it('captura medidas con decimales', () => {
    expect(extractVariantHint('balín de 6.0 mm')).toBe('6.0 mm');
  });

  it('captura la almohadilla de los balines', () => {
    expect(extractVariantHint('balín diamantado #6')).toBe('#6');
  });

  it('reconoce "tamaño" además de "talla"', () => {
    expect(extractVariantHint('tamaño grande')).toBe('grande');
  });

  it('reconoce tamaños cualitativos del catálogo', () => {
    expect(extractVariantHint('el pequeño por favor')).toBe('pequeno');
  });

  it('reconoce colores en femenino y plural', () => {
    expect(extractVariantHint('con piedras verdes')).toBe('verdes');
    expect(extractVariantHint('el de piedras blancas')).toBe('blancas');
    expect(extractVariantHint('color fucsia')).toBe('fucsia');
  });

  it('devuelve todas las medidas de un mensaje con varias variantes', () => {
    expect(extractAllVariantHints('una de 45 cm y otra de 60 cm')).toEqual(['45 cm', '60 cm']);
  });

  it('no confunde palabras vacías con variantes', () => {
    expect(extractVariantHint('quiero un dije bonito')).toBeUndefined();
  });
});

describe('variantHintsMatch', () => {
  it('tolera espacios en las medidas', () => {
    expect(variantHintsMatch('Cadena Lazo - 45 cm', '45cm')).toBe(true);
  });

  it('no confunde la talla 5 con la 5 1/2', () => {
    expect(variantHintsMatch('Talla: 5 1/2 · 0.93 g', '5')).toBe(false);
  });

  it('acierta la talla exacta', () => {
    expect(variantHintsMatch('Talla: 5', '5')).toBe(true);
    expect(variantHintsMatch('Talla: 5 1/2', '5 1/2')).toBe(true);
  });

  it('no confunde la talla 5 con la 15', () => {
    expect(variantHintsMatch('Tamaño: 15 mm', '5')).toBe(false);
  });

  it('acepta un número sin unidad frente a la medida completa', () => {
    expect(variantHintsMatch('Tamaño: 10 mm', '10')).toBe(true);
  });

  it('tolera que el cliente omita una dimensión', () => {
    expect(variantHintsMatch('Tamaño: 10 x 9 mm', '9 mm')).toBe(true);
  });

  it('compara colores en plural con el singular', () => {
    expect(variantHintsMatch('Piedras Verdes', 'verde')).toBe(true);
    expect(variantHintsMatch('Blancas', 'blanco')).toBe(false);
  });
});

describe('extractQuantityFromText', () => {
  it('lee la cantidad explícita', () => {
    expect(extractQuantityFromText('quiero 3 unidades')).toBe(3);
  });

  it('no toma "Promo x5" como cantidad', () => {
    expect(extractQuantityFromText('quiero la promo x5')).toBe(1);
  });

  it('no toma una dimensión como cantidad', () => {
    expect(extractQuantityFromText('el dije de 10 x 9 mm')).toBe(1);
  });
});

describe('extractProductFamilyTerm', () => {
  it('reconoce las familias reales de la tienda', () => {
    expect(extractProductFamilyTerm('tienen dijes?')).toBe('dijes');
    expect(extractProductFamilyTerm('quiero unos topos')).toBe('topos');
    expect(extractProductFamilyTerm('tienen herrajes')).toBe('herrajes');
    expect(extractProductFamilyTerm('venden canutillos')).toBe('canutillos');
  });

  it('reconoce como familia el término que usa el cliente aunque la tienda lo llame distinto', () => {
    expect(extractProductFamilyTerm('tienen aretes')).toBe('aretes');
  });

  it('aprende familias nuevas desde las categorías del catálogo', () => {
    expect(extractProductFamilyTerm('tienen mostacillas')).toBeNull();
    registerCatalogFamilyTerms(['mostacilla']);
    expect(extractProductFamilyTerm('tienen mostacillas')).toBe('mostacillas');
  });

  it('devuelve null cuando no se nombra un tipo de producto', () => {
    expect(extractProductFamilyTerm('hola buenas tardes')).toBeNull();
  });
});

describe('isProductOptionsBrowseIntent', () => {
  it('detecta que el cliente pide las variaciones de un producto nombrado', () => {
    expect(isProductOptionsBrowseIntent('que opciones tienes del anillo dama flor con circones?')).toBe(true);
    expect(isProductOptionsBrowseIntent('qué tallas tiene el anillo flor bordada')).toBe(true);
    expect(isProductFamilyBrowseIntent('que opciones tienes del anillo dama flor con circones?')).toBe(true);
  });

  it('no se activa con un listado de familia', () => {
    expect(isProductOptionsBrowseIntent('tienen anillos?')).toBe(false);
  });
});

describe('isThemeBrowseIntent', () => {
  it('detecta búsquedas por motivo o forma', () => {
    expect(isThemeBrowseIntent('alguna joya en forma de corazón?')).toBe(true);
    expect(isThemeBrowseIntent('busco algo en forma de cruz')).toBe(true);
  });

  it('no se deja ganar por el "tienen" inicial: sigue siendo búsqueda por forma', () => {
    expect(isThemeBrowseIntent('tienen joyas en forma de virgen?')).toBe(true);
    expect(isThemeBrowseIntent('tienen algo en forma de corazón')).toBe(true);
    expect(isCatalogBrowseIntent('tienen joyas en forma de virgen?')).toBe(false);
    expect(isProductFamilyBrowseIntent('tienen dijes en forma de virgen?')).toBe(false);
    expect(isThemeBrowseIntent('tienen dijes en forma de virgen?')).toBe(true);
  });

  it('el catálogo general sigue yendo al enlace de la tienda', () => {
    expect(isCatalogBrowseIntent('qué productos tienen?')).toBe(true);
    expect(isCatalogBrowseIntent('tienen productos?')).toBe(true);
    expect(isThemeBrowseIntent('qué productos tienen?')).toBe(false);
  });

  it('cede el paso al listado de familia cuando nombra un tipo de producto', () => {
    expect(isThemeBrowseIntent('tienen anillos?')).toBe(false);
    expect(isProductFamilyBrowseIntent('tienen anillos?')).toBe(true);
    expect(isProductFamilyBrowseIntent('ya no quiero el dije de corazón')).toBe(false);
  });

  it('resume la forma para el título del listado', () => {
    expect(themeListLabel('tienen joyas en forma de animales?')).toBe('animales');
    expect(themeListLabel('joyas en forma de corazón')).toBe('corazon');
  });
});

describe('isAvailabilityQuestion', () => {
  it('trata "tienen / hay" como consulta, no como pedido', () => {
    expect(isAvailabilityQuestion('Tienen balines #4')).toBe(true);
    expect(isAvailabilityQuestion('hay anillos talla 6?')).toBe(true);
    expect(isAvailabilityQuestion('venden dijes de corazón')).toBe(true);
    expect(isAvailabilityQuestion('quiero saber si tienen balines #4')).toBe(true);
  });

  it('no se activa cuando el cliente pide agregar', () => {
    expect(isAvailabilityQuestion('quiero balín #4')).toBe(false);
    expect(isAvailabilityQuestion('dame el balín #4')).toBe(false);
    expect(isAvailabilityQuestion('agrega balines #4')).toBe(false);
  });

  it('no agrega al carrito si solo preguntan disponibilidad con variante', () => {
    expect(isDirectVariantAddIntent('Tienen balines #4')).toBe(false);
    expect(hasConcreteProductSpec('Tienen balines #4')).toBe(false);
    expect(isDirectVariantAddIntent('quiero balín #4')).toBe(true);
    expect(hasConcreteProductSpec('quiero balín #4')).toBe(true);
    expect(isDirectVariantAddIntent('balín #4')).toBe(true);
  });
});
