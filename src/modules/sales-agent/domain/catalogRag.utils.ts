import {
  looksLikeSku,
  normalizeProductText,
  tokenizeProductQuery,
  variantHintsMatch,
} from './productSelection.utils';

export interface CatalogProductFields {
  producto?: string;
  sku?: string;
  variaciones?: string;
  milimetros?: string;
  etiquetas?: string;
  palabraClaveSeo?: string;
  descripcionCorta?: string;
  estado?: string;
}

const FIELD_ALIASES: Record<string, keyof CatalogProductFields> = {
  producto: 'producto',
  sku: 'sku',
  variaciones: 'variaciones',
  milimetros: 'milimetros',
  etiquetas: 'etiquetas',
  palabraclaveseo: 'palabraClaveSeo',
  descripcioncorta: 'descripcionCorta',
  estado: 'estado',
};

const PACK_SIZES = [1, 2, 5, 10] as const;

/** Normaliza claves del catálogo MASSI (`Producto:`, `Palabra Clave SEO:`, etc.). */
export function normalizeCatalogFieldKey(raw: string): string {
  return normalizeProductText(raw).replace(/\s+/g, '');
}

/** Parsea un bloque de producto del .txt (entre separadores `---`). */
export function parseCatalogProductFields(block: string): CatalogProductFields {
  const fields: Partial<CatalogProductFields> = {};
  let currentKey: keyof CatalogProductFields | '' = '';

  for (const line of block.split('\n')) {
    const kv = line.match(/^([A-Za-zÁÉÍÓÚáéíóúñ0-9\s()]+):\s*(.*)$/);
    const isFieldLine =
      kv &&
      kv[1]!.length <= 48 &&
      !kv[1]!.includes('http') &&
      !kv[1]!.includes('://');

    if (isFieldLine) {
      const normalized = normalizeCatalogFieldKey(kv![1]!);
      currentKey = FIELD_ALIASES[normalized] ?? '';
      if (currentKey) {
        fields[currentKey] = kv![2]!.trim();
      }
      continue;
    }

    const trimmed = line.trim();
    if (currentKey && trimmed) {
      const prev = fields[currentKey] ?? '';
      fields[currentKey] = prev ? `${prev}\n${trimmed}` : trimmed;
    }
  }

  return fields as CatalogProductFields;
}

/** Extrae SKUs de un bloque (soporta varios SKUs en líneas consecutivas). */
export function extractSkusFromCatalogField(skuField: string | undefined): string[] {
  if (!skuField?.trim()) return [];

  const skus: string[] = [];
  for (const line of skuField.split('\n')) {
    const token = line.trim();
    if (looksLikeSku(token)) skus.push(token);
  }
  return skus;
}

/** Separa bloques de producto por `---`. */
export function splitCatalogBlocks(content: string): string[] {
  return content
    .split(/\n---+\n/)
    .map((block) => block.trim())
    .filter((block) => /producto\s*:/i.test(block));
}

function extractHashSize(text: string): string | null {
  const hash = text.match(/#\s*(\d+)/);
  if (hash) return hash[1]!;
  const mm = text.match(/\b(\d+(?:[.,]\d+)?)\s*mm\b/i);
  if (mm) return mm[1]!.replace(',', '.');
  return null;
}

/** Pack de balines u otras variaciones numéricas (1, 2, 5, 10 unidades). */
export function extractPackSizeHint(text: string, variaciones?: string): number | null {
  const normalized = normalizeProductText(text);

  const inline = normalized.match(/\b(1|2|5|10)\s*bal[ií]n/);
  if (inline) return Number.parseInt(inline[1]!, 10);

  if (variaciones) {
    for (const label of variaciones.split('|').map((part) => part.trim())) {
      const num = label.match(/^(\d+)/);
      if (!num) continue;
      const pack = Number.parseInt(num[1]!, 10);
      const labelNorm = normalizeProductText(label);
      if (normalized.includes(labelNorm) || normalized.includes(`${pack} balin`)) {
        return pack;
      }
    }
  }

  return null;
}

function skuPackCode(sku: string): number | null {
  const match = sku.match(/-(\d{2})$/);
  if (!match) return null;
  const code = Number.parseInt(match[1]!, 10);
  return PACK_SIZES.includes(code as (typeof PACK_SIZES)[number]) ? code : null;
}

function scoreFieldOverlap(userTokens: string[], fieldText: string | undefined): number {
  if (!fieldText?.trim()) return 0;
  const fieldNorm = normalizeProductText(fieldText);
  let score = 0;
  for (const token of userTokens) {
    if (token.length >= 3 && fieldNorm.includes(token)) score += token.length >= 5 ? 3 : 2;
  }
  return score;
}

/** Puntúa qué tan bien un bloque del catálogo coincide con lo que escribió el cliente. */
export function scoreCatalogBlockMatch(fields: CatalogProductFields, userText: string, variantHint?: string): number {
  if (fields.estado && /^borrador$/i.test(fields.estado.trim())) return 0;

  const userTokens = tokenizeProductQuery(userText);
  if (!userTokens.length) return 0;

  let score = 0;
  score += scoreFieldOverlap(userTokens, fields.producto) * 2;
  score += scoreFieldOverlap(userTokens, fields.etiquetas);
  score += scoreFieldOverlap(userTokens, fields.palabraClaveSeo);
  score += scoreFieldOverlap(userTokens, fields.descripcionCorta);

  const userSize = extractHashSize(userText) ?? (variantHint ? extractHashSize(variantHint) : null);
  if (userSize && fields.milimetros) {
    const mmNorm = normalizeProductText(fields.milimetros).replace(/[^\d.]/g, '');
    const sizeNorm = userSize.replace(/[^\d.]/g, '');
    if (mmNorm === sizeNorm || mmNorm.startsWith(sizeNorm)) score += 12;
  }

  if (userSize && fields.producto && fields.producto.includes(`#${userSize}`)) score += 10;

  if (variantHint && fields.variaciones) {
    for (const label of fields.variaciones.split('|')) {
      if (variantHintsMatch(label, variantHint) || variantHintsMatch(label, userText)) {
        score += 8;
        break;
      }
    }
  }

  return score;
}

/** Elige el SKU correcto dentro de un bloque (pack, medida, variación). */
export function pickSkuFromCatalogBlock(
  fields: CatalogProductFields,
  userText: string,
  variantHint?: string
): string | null {
  const skus = extractSkusFromCatalogField(fields.sku);
  if (!skus.length) return null;
  if (skus.length === 1) return skus[0]!;

  const packHint = extractPackSizeHint(userText, fields.variaciones) ?? extractPackSizeHint(variantHint ?? '', fields.variaciones);
  if (packHint) {
    const byPack = skus.find((sku) => skuPackCode(sku) === packHint);
    if (byPack) return byPack;
  }

  if (fields.variaciones && (variantHint || userText)) {
    const labels = fields.variaciones.split('|').map((part) => part.trim());
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i]!;
      if (variantHintsMatch(label, variantHint ?? '') || variantHintsMatch(label, userText)) {
        return skus[i] ?? skus[0]!;
      }
    }
  }

  return skus[0]!;
}

export interface RagCatalogMatch {
  sku: string;
  productName: string;
  score: number;
}

export interface RagChunkLike {
  content: string;
  score: number;
}

/**
 * Interpreta chunks RAG del catálogo .txt → producto + SKU.
 * WooCommerce valida stock después; aquí solo identificamos intención.
 */
export function resolveSkuFromRagChunks(
  chunks: RagChunkLike[],
  userText: string,
  variantHint?: string,
  minScore = 6
): RagCatalogMatch | null {
  let best: RagCatalogMatch | null = null;

  for (const chunk of chunks) {
    for (const block of splitCatalogBlocks(chunk.content)) {
      const fields = parseCatalogProductFields(block);
      const blockScore = scoreCatalogBlockMatch(fields, userText, variantHint) + chunk.score * 4;
      if (blockScore < minScore) continue;

      const sku = pickSkuFromCatalogBlock(fields, userText, variantHint);
      if (!sku) continue;

      const candidate: RagCatalogMatch = {
        sku,
        productName: fields.producto?.trim() || sku,
        score: blockScore,
      };

      if (!best || candidate.score > best.score) best = candidate;
    }

    // Chunks parciales sin `---` pero con Producto:/SKU:
    if (!splitCatalogBlocks(chunk.content).length && /producto\s*:/i.test(chunk.content)) {
      const fields = parseCatalogProductFields(chunk.content);
      const blockScore = scoreCatalogBlockMatch(fields, userText, variantHint) + chunk.score * 4;
      const sku = pickSkuFromCatalogBlock(fields, userText, variantHint);
      if (sku && blockScore >= minScore) {
        const candidate: RagCatalogMatch = {
          sku,
          productName: fields.producto?.trim() || sku,
          score: blockScore,
        };
        if (!best || candidate.score > best.score) best = candidate;
      }
    }
  }

  return best;
}
