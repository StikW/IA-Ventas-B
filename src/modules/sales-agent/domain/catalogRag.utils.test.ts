import { describe, expect, it } from 'vitest';
import {
  extractPackSizeHint,
  extractSkusFromCatalogField,
  parseCatalogProductFields,
  pickSkuFromCatalogBlock,
  resolveSkuFromRagChunks,
  scoreCatalogBlockMatch,
} from './catalogRag.utils';

const BALIN_DI6_BLOCK = `Producto: Balines diamantados #6
SKU: BAL-DI6-01
BAL-DI6-02
BAL-DI6-05
BAL-DI6-10
Categoría: Balín Diamantado
Etiquetas: #6, Oro 18k, Balines, Diamantado
Milímetros: 6.0
Variaciones: 1 Balín|2 Balines|5 Balines|10 Balines
Descripción corta: Balín diamantado #6 en oro de 18k con brillo facetado.
Palabra Clave SEO: balín diamantado oro 18k 6 mm
ESTADO: Listo`;

describe('catalogRag.utils', () => {
  it('parsea SKUs multilínea del catálogo MASSI', () => {
    const fields = parseCatalogProductFields(BALIN_DI6_BLOCK);
    expect(fields.producto).toBe('Balines diamantados #6');
    expect(extractSkusFromCatalogField(fields.sku)).toEqual([
      'BAL-DI6-01',
      'BAL-DI6-02',
      'BAL-DI6-05',
      'BAL-DI6-10',
    ]);
  });

  it('elige SKU por talla #6 sin pack explícito (default 1 balín)', () => {
    const fields = parseCatalogProductFields(BALIN_DI6_BLOCK);
    expect(pickSkuFromCatalogBlock(fields, 'quiero balín diamantado #6', undefined)).toBe('BAL-DI6-01');
  });

  it('elige SKU por pack de 5 balines', () => {
    const fields = parseCatalogProductFields(BALIN_DI6_BLOCK);
    expect(pickSkuFromCatalogBlock(fields, '5 balines diamantados #6', undefined)).toBe('BAL-DI6-05');
  });

  it('puntúa mejor el bloque correcto frente a otro tamaño', () => {
    const fields6 = parseCatalogProductFields(BALIN_DI6_BLOCK);
    const fields3 = parseCatalogProductFields(BALIN_DI6_BLOCK.replace('#6', '#3').replace('6.0', '3.0'));

    const score6 = scoreCatalogBlockMatch(fields6, 'balín diamantado #6 oro 18k');
    const score3 = scoreCatalogBlockMatch(fields3, 'balín diamantado #6 oro 18k');

    expect(score6).toBeGreaterThan(score3);
  });

  it('resuelve SKU desde chunks RAG simulados', () => {
    const match = resolveSkuFromRagChunks(
      [{ content: `---\n${BALIN_DI6_BLOCK}\n---`, score: 0.82 }],
      'me interesa un balín diamantado número 6',
      undefined
    );

    expect(match?.sku).toBe('BAL-DI6-01');
    expect(match?.productName).toContain('#6');
  });

  it('ignora productos en borrador', () => {
    const draft = parseCatalogProductFields(`Producto: Ejemplo\nSKU: AN-001\nESTADO: Borrador`);
    expect(scoreCatalogBlockMatch(draft, 'anillo compromiso')).toBe(0);
  });

  it('detecta pack desde variaciones', () => {
    expect(extractPackSizeHint('2 balines #6', '1 Balín|2 Balines|5 Balines|10 Balines')).toBe(2);
  });
});
