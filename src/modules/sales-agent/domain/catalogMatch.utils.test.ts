import { describe, expect, it } from 'vitest';
import { WooCommerceProduct } from '../../woocommerce/domain/IWooCommerceService';
import {
  buildCatalogEntry,
  catalogQueryTokens,
  collectFamilyTerms,
  findFamilyEntries,
  findThemeMatches,
  isDecisiveMatch,
  rankCatalogEntries,
} from './catalogMatch.utils';
import { themeQueryTokens } from './productSelection.utils';

/** Muestra representativa del catálogo real de MASSI Joyería. */
function product(
  id: number,
  name: string,
  categories: string[],
  overrides: Partial<WooCommerceProduct> = {}
): WooCommerceProduct {
  return {
    id,
    name,
    sku: `SKU-${id}`,
    price: '100000',
    stockQuantity: 5,
    stockStatus: 'instock',
    description: '',
    status: 'publish',
    type: 'simple',
    categories: categories.map((label, index) => ({
      id: 100 + index,
      name: label,
      slug: label.toLowerCase().replace(/\s+/g, '-'),
    })),
    tags: [],
    ...overrides,
  };
}

const CATALOG = [
  product(1, 'Dije Virgen del Carmen Rectangular de 12 mm en oro nacional amarillo', ['Dijes', 'Religioso']),
  product(2, 'Dije Virgen Milagrosa Lisa de 12 × 8 mm en oro nacional', ['Dijes', 'Religioso']),
  product(3, 'Dije Trébol Diamantado', ['Dijes', 'Trébol']),
  product(4, 'Topos Trébol de 4 mm en Oro Nacional Amarillo', ['Topos']),
  product(5, 'Topos Corazón Bordados en Oro Nacional', ['Topos', 'corazón']),
  product(6, 'Herraje San Benito', ['Herraje', 'Religioso']),
  product(7, 'Herraje Estrella Lisa Plana de 10 mm', ['Herraje']),
  product(8, 'Cadena Lazo en Oro 18K', ['Ley 750'], { type: 'variable', sku: '' }),
  product(9, 'Anillo Corazón Infinito', ['Anillos Oro Nacional'], { type: 'variable', sku: '' }),
  product(10, 'Balín Diamantado #6 Oro Amarillo', ['Balín Diamantado Oro Amarillo']),
].map(buildCatalogEntry);

describe('catalogMatch.utils', () => {
  it('encuentra productos en plural, que el search de WooCommerce descarta', () => {
    const { matched, resolvedTerm } = findFamilyEntries(CATALOG, 'dijes');
    expect(resolvedTerm).toBe('dijes');
    expect(matched).toHaveLength(3);
  });

  it('resuelve "aretes" hacia la familia real de la tienda ("topos")', () => {
    const { matched, resolvedTerm } = findFamilyEntries(CATALOG, 'aretes');
    expect(resolvedTerm).toBe('topo');
    expect(matched.map((entry) => entry.product.id)).toEqual([4, 5]);
  });

  it('reconoce familias que no estaban en la lista original del código', () => {
    expect(findFamilyEntries(CATALOG, 'herrajes').matched).toHaveLength(2);
    expect(findFamilyEntries(CATALOG, 'herraje').matched).toHaveLength(2);
  });

  it('encuentra "anillos" aunque la palabra no esté entre las primeras del nombre', () => {
    const late = [
      ...CATALOG,
      buildCatalogEntry(
        product(12, 'Dama Flor Circones Anillo Infinito', ['Oro Nacional'], { type: 'variable', sku: '' })
      ),
    ];
    expect(findFamilyEntries(late, 'anillos').matched.map((entry) => entry.product.id)).toEqual(
      expect.arrayContaining([9, 12])
    );
  });

  it('ignora las palabras de la pregunta al puntuar', () => {
    const matches = rankCatalogEntries(
      CATALOG,
      catalogQueryTokens('que opciones tienes del anillo corazon infinito')
    );
    expect(matches[0]?.entry.product.id).toBe(9);
    expect(isDecisiveMatch(matches)).toBe(true);
  });

  it('resuelve una descripción de varias palabras', () => {
    const matches = rankCatalogEntries(CATALOG, catalogQueryTokens('dije de la virgen del carmen'));
    expect(matches[0]?.entry.product.id).toBe(1);
    expect(isDecisiveMatch(matches)).toBe(true);
  });

  it('prioriza el producto correcto entre varios de la misma familia', () => {
    const matches = rankCatalogEntries(CATALOG, catalogQueryTokens('topos de corazon'));
    expect(matches[0]?.entry.product.id).toBe(5);
  });

  it('marca como ambiguo cuando hay dos productos equivalentes', () => {
    const duplicated = [
      ...CATALOG,
      buildCatalogEntry(
        product(11, 'Dije Virgen del Carmen Rectangular de 12 mm en oro nacional amarillo', ['Dijes'])
      ),
    ];
    const matches = rankCatalogEntries(duplicated, catalogQueryTokens('dije virgen del carmen'));
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(isDecisiveMatch(matches)).toBe(false);
  });

  it('no devuelve candidatos cuando nada coincide', () => {
    expect(rankCatalogEntries(CATALOG, catalogQueryTokens('reloj automatico'))).toHaveLength(0);
  });

  it('deriva los términos de familia del catálogo del negocio', () => {
    const terms = collectFamilyTerms(CATALOG, 2);
    expect(terms).toContain('dije');
    expect(terms).toContain('topos');
    expect(terms).toContain('herraje');
  });

  it('no toma materiales ni motivos como tipos de producto', () => {
    const terms = collectFamilyTerms(CATALOG, 2);
    expect(terms).not.toContain('amarillo');
    expect(terms).not.toContain('nacional');
    expect(terms).not.toContain('religioso');
    expect(terms).not.toContain('virgen');
  });

  it('posterga los productos agotados frente a los disponibles', () => {
    const withOutOfStock = [
      buildCatalogEntry(product(20, 'Dije Trébol Diamantado Grande', ['Dijes'], { stockStatus: 'outofstock' })),
      buildCatalogEntry(product(21, 'Dije Trébol Diamantado Grande', ['Dijes'])),
    ];
    const matches = rankCatalogEntries(withOutOfStock, catalogQueryTokens('dije trebol diamantado grande'));
    expect(matches[0]?.entry.product.id).toBe(21);
  });
});

describe('findThemeMatches', () => {
  const ANIMALS = [
    product(30, 'Dije Búho Plano de 8 mm en Oro Nacional Amarillo', ['Animal', 'Dijes']),
    product(31, 'Herraje Caballo 10 mm en Oro Nacional Amarillo', ['Animal', 'Herraje']),
    product(32, 'Dije Mariposa Diamantada Bordada', ['Animal', 'Dijes']),
    product(33, 'Herraje Estrella Plana de 11 mm', ['Estrella', 'Herraje']),
  ].map(buildCatalogEntry);

  it('lista por categoría el motivo que no aparece en ningún nombre', () => {
    const matches = findThemeMatches(ANIMALS, themeQueryTokens('tienen joyas de animales?'));
    expect(matches.map((match) => match.entry.product.id).sort()).toEqual([30, 31, 32]);
  });

  it('prefiere el nombre sobre la categoría al ordenar', () => {
    const matches = findThemeMatches(CATALOG, themeQueryTokens('joyas de la virgen'));
    expect(matches.map((match) => match.entry.product.id)).toEqual([1, 2]);
  });

  it('exige el motivo completo cuando hay productos que lo cubren', () => {
    const matches = findThemeMatches(CATALOG, themeQueryTokens('algo de la virgen del carmen'));
    expect(matches.map((match) => match.entry.product.id)).toEqual([1]);
  });

  it('busca también en las etiquetas del producto', () => {
    const tagged = [
      buildCatalogEntry(
        product(40, 'Dije Silueta Doble de 7 mm', ['Dijes'], { tags: ['Huella de perro', 'Mascotas'] })
      ),
    ];
    expect(findThemeMatches(tagged, themeQueryTokens('tienen algo de mascotas'))).toHaveLength(1);
  });

  it('no inventa resultados para un motivo que la tienda no maneja', () => {
    expect(findThemeMatches(CATALOG, themeQueryTokens('tienen joyas de dinosaurios?'))).toHaveLength(0);
  });
});
