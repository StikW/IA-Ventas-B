import { inject, injectable } from 'tsyringe';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import {
  IWooCommerceService,
  WooCommerceConfigData,
  WooCommerceProduct,
} from '../../../woocommerce/domain/IWooCommerceService';
import {
  CatalogEntry,
  CatalogMatch,
  buildCatalogEntry,
  catalogQueryTokens,
  collectFamilyTerms,
  findFamilyEntries,
  findThemeMatches,
  rankCatalogEntries,
} from '../../domain/catalogMatch.utils';
import {
  normalizeProductText,
  registerCatalogFamilyTerms,
  themeQueryTokens,
  tokensRelated,
} from '../../domain/productSelection.utils';

/** El catálogo cambia poco durante una conversación; evita repetir la paginación completa. */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedIndex {
  entries: CatalogEntry[];
  familyTerms: string[];
  fetchedAt: number;
}

/**
 * Índice en memoria del catálogo WooCommerce por tenant.
 *
 * Sustituye la dependencia del `search` de WooCommerce, que es una coincidencia literal de
 * frase y falla con plurales y descripciones de varias palabras. Traer el catálogo completo
 * cuesta una página por cada 100 productos y permite puntuar todos los candidatos.
 */
@injectable()
export class CatalogIndexService {
  private readonly cache = new Map<string, CachedIndex>();
  private readonly inFlight = new Map<string, Promise<CachedIndex | null>>();

  constructor(@inject('IWooCommerceService') private readonly wcService: IWooCommerceService) {}

  /** Fuerza recarga en la próxima consulta (cambios de catálogo desde el panel). */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async load(tenantId: string, config: WooCommerceConfigData): Promise<CachedIndex | null> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

    const pending = this.inFlight.get(tenantId);
    if (pending) return pending;

    const task = (async (): Promise<CachedIndex | null> => {
      try {
        const products = await this.wcService.listAllProducts(config);
        const entries = products.map(buildCatalogEntry);
        const familyTerms = collectFamilyTerms(entries);

        // El gate sincrónico de "consulta por tipo de producto" aprende las familias reales
        // de la tienda, sin depender de una lista fija en el código.
        registerCatalogFamilyTerms(familyTerms);

        const index: CachedIndex = { entries, familyTerms, fetchedAt: Date.now() };
        this.cache.set(tenantId, index);
        return index;
      } catch (err) {
        // Si la tienda falla, el agente sigue con los caminos por SKU y RAG.
        logger.error(
          { tenantId, err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
          'No se pudo cargar el índice del catálogo'
        );
        return cached ?? null;
      } finally {
        this.inFlight.delete(tenantId);
      }
    })();

    this.inFlight.set(tenantId, task);
    return task;
  }

  async getEntries(tenantId: string, config: WooCommerceConfigData): Promise<CatalogEntry[]> {
    const index = await this.load(tenantId, config);
    return index?.entries ?? [];
  }

  /** Candidatos ordenados para una descripción en lenguaje natural. */
  async search(
    tenantId: string,
    config: WooCommerceConfigData,
    query: string,
    variantHint?: string,
    limit = 10
  ): Promise<CatalogMatch[]> {
    const entries = await this.getEntries(tenantId, config);
    if (!entries.length) return [];

    const tokens = catalogQueryTokens(query);
    if (!tokens.length) return [];

    return rankCatalogEntries(entries, tokens, variantHint, limit);
  }

  /**
   * Productos de un motivo ("animales", "virgen", "religioso"), buscando en categorías y
   * etiquetas además del nombre. Devuelve también los tokens usados, para titular el listado.
   */
  async findTheme(
    tenantId: string,
    config: WooCommerceConfigData,
    userText: string,
    limit = 10
  ): Promise<{ matches: CatalogMatch[]; tokens: string[] }> {
    const tokens = themeQueryTokens(userText);
    if (!tokens.length) return { matches: [], tokens };

    const entries = await this.getEntries(tenantId, config);
    return { matches: findThemeMatches(entries, tokens, limit), tokens };
  }

  /** Productos de un tipo ("dijes", "aretes" → topos), resolviendo sinónimos. */
  async findFamily(
    tenantId: string,
    config: WooCommerceConfigData,
    term: string
  ): Promise<{ products: WooCommerceProduct[]; resolvedTerm: string }> {
    const entries = await this.getEntries(tenantId, config);
    const { matched, resolvedTerm } = findFamilyEntries(entries, term);
    return { products: matched.map((entry) => entry.product), resolvedTerm };
  }

  /**
   * Familia + descripción adicional: "dijes de virgen" → dijes ordenados por relevancia.
   * Si el cliente solo nombra la familia, devuelve los disponibles primero.
   *
   * `matches` viene con puntaje para que quien llame decida si el cliente nombró un
   * producto concreto ("opciones del anillo dama flor con circones") en vez de la familia.
   */
  async findFamilyRanked(
    tenantId: string,
    config: WooCommerceConfigData,
    term: string,
    userText: string,
    variantHint?: string
  ): Promise<{ products: WooCommerceProduct[]; resolvedTerm: string; matches: CatalogMatch[] }> {
    const entries = await this.getEntries(tenantId, config);
    const { matched, resolvedTerm } = findFamilyEntries(entries, term);
    if (!matched.length) return { products: [], resolvedTerm, matches: [] };

    // "dijes de virgen" → ordenar por "virgen"; el tipo de producto ya está filtrado.
    const extraTokens = catalogQueryTokens(userText).filter(
      (token) => !tokensRelated(token, resolvedTerm) && !tokensRelated(token, normalizeProductText(term))
    );

    const ranked = extraTokens.length
      ? rankCatalogEntries(matched, extraTokens, variantHint, matched.length)
      : [];

    const ordered = ranked.length
      ? ranked.map((match) => match.entry.product)
      : matched
          .map((entry) => entry.product)
          .sort((a, b) => Number(b.stockStatus === 'instock') - Number(a.stockStatus === 'instock'));

    return { products: ordered, resolvedTerm, matches: ranked };
  }
}
