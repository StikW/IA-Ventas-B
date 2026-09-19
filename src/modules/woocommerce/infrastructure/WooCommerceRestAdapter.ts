import http from 'node:http';
import https from 'node:https';
import { injectable } from 'tsyringe';
import {
  CatalogTxtSourceEntry,
  CatalogTxtProduct,
  CatalogTxtVariation,
  IWooCommerceService,
  WooCommerceConfigData,
  WooCommerceOrderPayload,
  WooCommerceOrderResult,
  WooCommerceOrderUpdatePayload,
  WooCommerceProduct,
} from '../domain/IWooCommerceService';
import { DomainError } from '../../../shared/domain/errors/DomainError';
import { env } from '../../../shared/infrastructure/config/env';

const localDevHttpsAgent = new https.Agent({ rejectUnauthorized: false });

@injectable()
export class WooCommerceRestAdapter implements IWooCommerceService {
  private baseUrl(config: WooCommerceConfigData): string {
    return config.storeUrl.replace(/\/$/, '') + '/wp-json/wc/v3';
  }

  private isLocalDevStore(storeUrl: string): boolean {
    try {
      const { hostname } = new URL(storeUrl);
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local');
    } catch {
      return false;
    }
  }

  private buildFetchInit(url: string, options?: RequestInit): RequestInit {
    return {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers as Record<string, string> | undefined),
      },
    };
  }

  private httpRequest(url: string, options?: RequestInit): Promise<{ status: number; body: string }> {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const method = options?.method ?? 'GET';
    const headers = (options?.headers as Record<string, string> | undefined) ?? {};
    const body = typeof options?.body === 'string' ? options.body : undefined;

    const useInsecureLocalTls =
      isHttps && env.NODE_ENV !== 'production' && this.isLocalDevStore(parsed.origin);

    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method,
          headers: {
            ...headers,
            ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          },
          agent: useInsecureLocalTls ? localDevHttpsAgent : undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk as Buffer));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 500,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );

      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * Query string auth: compatible con HTTP local y HTTPS cuando nginx/Apache
   * no reenvía el header Authorization (común en Local WP).
   */
  private buildRequestUrl(config: WooCommerceConfigData, path: string): string {
    const url = `${this.baseUrl(config)}${path}`;
    const separator = path.includes('?') ? '&' : '?';
    const key = encodeURIComponent(config.consumerKey);
    const secret = encodeURIComponent(config.consumerSecret);
    return `${url}${separator}consumer_key=${key}&consumer_secret=${secret}`;
  }

  private async request<T>(config: WooCommerceConfigData, path: string, options?: RequestInit): Promise<T> {
    if (!config.consumerKey?.trim() || !config.consumerSecret?.trim()) {
      throw new DomainError(
        'WooCommerce sin credenciales. Vuelve a guardar Consumer Key y Consumer Secret.',
        'WOOCOMMERCE_NOT_CONFIGURED'
      );
    }

    const url = this.buildRequestUrl(config, path);
    const init = this.buildFetchInit(url, options);
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { status, body } = await this.httpRequest(url, init);

      if (status >= 200 && status < 300) {
        return JSON.parse(body) as T;
      }

      const retryable = status === 502 || status === 503 || status === 504;
      if (retryable && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        continue;
      }

      throw new DomainError(`WooCommerce error ${status}: ${body}`, 'WOOCOMMERCE_ERROR');
    }

    throw new DomainError('WooCommerce error: reintentos agotados', 'WOOCOMMERCE_ERROR');
  }

  async testConnection(config: WooCommerceConfigData): Promise<{ checkoutPagePath?: string; shopPagePath?: string }> {
    await this.request(config, '/products?per_page=1');
    const [checkoutPagePath, shopPagePath] = await Promise.all([
      this.resolveCheckoutPagePath(config),
      this.resolveShopPagePath(config),
    ]);
    return {
      checkoutPagePath: checkoutPagePath ?? undefined,
      shopPagePath: shopPagePath ?? undefined,
    };
  }

  async resolveCheckoutPagePath(config: WooCommerceConfigData): Promise<string | null> {
    return this.resolvePagePathFromSetting(config, '/settings/advanced/woocommerce_checkout_page_id');
  }

  async resolveShopPagePath(config: WooCommerceConfigData): Promise<string | null> {
    return this.resolvePagePathFromSetting(config, '/settings/products/woocommerce_shop_page_id');
  }

  private async resolvePagePathFromSetting(
    config: WooCommerceConfigData,
    settingPath: string
  ): Promise<string | null> {
    try {
      const setting = await this.request<{ value?: string }>(config, settingPath);
      const pageId = Number.parseInt(String(setting.value ?? ''), 10);
      if (!pageId) return null;

      const pageUrl = `${config.storeUrl.replace(/\/$/, '')}/wp-json/wp/v2/pages/${pageId}`;
      const { status, body } = await this.httpRequest(pageUrl, this.buildFetchInit(pageUrl));
      if (status < 200 || status >= 300) return null;

      const page = JSON.parse(body) as { slug?: string };
      const slug = page.slug?.trim();
      return slug ? `/${slug}/` : null;
    } catch {
      return null;
    }
  }

  async listProducts(config: WooCommerceConfigData, page = 1): Promise<WooCommerceProduct[]> {
    const products = await this.request<Array<Record<string, unknown>>>(
      config,
      `/products?per_page=50&page=${page}&status=publish`
    );

    return products.map((p) => this.mapProduct(p));
  }

  async listAllProducts(config: WooCommerceConfigData, maxProducts = 1000): Promise<WooCommerceProduct[]> {
    const perPage = 100;
    const all: WooCommerceProduct[] = [];

    for (let page = 1; all.length < maxProducts; page++) {
      const batch = await this.request<Array<Record<string, unknown>>>(
        config,
        `/products?per_page=${perPage}&page=${page}&status=publish&orderby=id&order=asc`
      );

      all.push(...batch.map((p) => this.mapProduct(p)));
      if (batch.length < perPage) break;
    }

    return all.slice(0, maxProducts);
  }

  async listCatalogTxtSource(config: WooCommerceConfigData): Promise<CatalogTxtSourceEntry[]> {
    const perPage = 100;
    const products: CatalogTxtProduct[] = [];

    for (let page = 1; ; page++) {
      const batch = await this.request<Array<Record<string, unknown>>>(
        config,
        `/products?per_page=${perPage}&page=${page}&status=publish&orderby=id&order=asc`
      );
      products.push(...batch.map((item) => this.mapCatalogTxtProduct(item)));
      if (batch.length < perPage) break;
    }

    const entries: CatalogTxtSourceEntry[] = [];
    for (const product of products) {
      const variations =
        product.type === 'variable' ? await this.listCatalogTxtVariations(config, product.id) : [];
      entries.push({ product, variations });
    }
    return entries;
  }

  async searchProducts(config: WooCommerceConfigData, query: string): Promise<WooCommerceProduct[]> {
    const q = query.trim();
    if (!q) return [];

    if (q.length >= 2) {
      const bySku = await this.getProductBySku(config, q);
      if (bySku) return [bySku];
    }

    const products = await this.request<Array<Record<string, unknown>>>(
      config,
      `/products?search=${encodeURIComponent(q)}&per_page=20&status=publish`
    );

    return products.map((p) => this.mapProduct(p));
  }

  async getProductBySku(config: WooCommerceConfigData, sku: string): Promise<WooCommerceProduct | null> {
    const products = await this.request<Array<Record<string, unknown>>>(
      config,
      `/products?sku=${encodeURIComponent(sku)}`
    );
    if (!products.length) return null;
    return this.mapProduct(products[0]);
  }

  async listProductVariations(config: WooCommerceConfigData, productId: number): Promise<WooCommerceProduct[]> {
    if (!productId || productId <= 0) return [];

    const variations = await this.request<Array<Record<string, unknown>>>(
      config,
      `/products/${productId}/variations?per_page=100&status=publish`
    );
    return variations.map((variation) => this.mapVariation(variation, productId));
  }

  async getProductById(config: WooCommerceConfigData, productId: number): Promise<WooCommerceProduct | null> {
    if (!productId || productId <= 0) return null;
    try {
      const product = await this.request<Record<string, unknown>>(config, `/products/${productId}`);
      return this.mapProduct(product);
    } catch {
      return null;
    }
  }

  async createOrder(config: WooCommerceConfigData, order: WooCommerceOrderPayload): Promise<WooCommerceOrderResult> {
    const result = await this.request<Record<string, unknown>>(config, '/orders', {
      method: 'POST',
      body: JSON.stringify(order),
    });

    return this.mapOrderResult(result);
  }

  async updateOrder(
    config: WooCommerceConfigData,
    orderId: number,
    update: WooCommerceOrderUpdatePayload
  ): Promise<WooCommerceOrderResult> {
    const result = await this.request<Record<string, unknown>>(config, `/orders/${orderId}`, {
      method: 'PUT',
      body: JSON.stringify(update),
    });

    return this.mapOrderResult(result);
  }

  private mapOrderResult(result: Record<string, unknown>): WooCommerceOrderResult {
    return {
      id: result.id as number,
      number: String(result.number),
      status: result.status as string,
      total: result.total as string,
    };
  }

  /**
   * WooCommerce devuelve `price` como cadena, pero los plugins que recalculan precios
   * (en MASSI, `woo-massi`) lo serializan como número. Todo el agente lo trata como texto.
   */
  private toPriceString(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    return '';
  }

  private mapVariation(p: Record<string, unknown>, _parentId: number): WooCommerceProduct {
    const attributes = Array.isArray(p.attributes) ? (p.attributes as Array<Record<string, unknown>>) : [];
    const label = attributes
      .map((attribute) => String(attribute.option ?? attribute.name ?? '').trim())
      .filter(Boolean)
      .join(' · ');

    return {
      id: p.id as number,
      name: label || String(p.name ?? `Variación ${p.id}`),
      sku: (p.sku as string) ?? '',
      price: this.toPriceString(p.price),
      stockQuantity: p.stock_quantity as number | null,
      stockStatus: p.stock_status as string,
      description: '',
      status: (p.status as string) ?? 'publish',
      type: 'variation',
      tags: attributes.map((attribute) => `${attribute.name ?? ''}: ${attribute.option ?? ''}`),
    };
  }

  private async listCatalogTxtVariations(
    config: WooCommerceConfigData,
    productId: number
  ): Promise<CatalogTxtVariation[]> {
    const variations = await this.request<Array<Record<string, unknown>>>(
      config,
      `/products/${productId}/variations?per_page=100`
    );
    return variations.map((item) => this.mapCatalogTxtVariation(item));
  }

  private mapCatalogTxtProduct(p: Record<string, unknown>): CatalogTxtProduct {
    const taxonomy = (raw: unknown): Array<Record<string, unknown>> =>
      Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    const metaRaw = Array.isArray(p.meta_data) ? (p.meta_data as Array<Record<string, unknown>>) : [];
    const attributes = Array.isArray(p.attributes) ? (p.attributes as Array<Record<string, unknown>>) : [];

    return {
      id: Number(p.id ?? 0),
      name: String(p.name ?? ''),
      sku: String(p.sku ?? ''),
      type: String(p.type ?? 'simple'),
      status: String(p.status ?? 'publish'),
      price: this.toPriceString(p.price),
      short_description: String(p.short_description ?? ''),
      stock_status: String(p.stock_status ?? ''),
      categories: taxonomy(p.categories).map((c) => ({
        id: Number(c.id ?? 0),
        name: String(c.name ?? ''),
      })),
      tags: taxonomy(p.tags).map((t) => ({
        id: Number(t.id ?? 0),
        name: String(t.name ?? ''),
      })),
      attributes: attributes.map((attribute) => ({
        name: String(attribute.name ?? ''),
        options: Array.isArray(attribute.options) ? attribute.options.map((option) => String(option)) : [],
      })),
      meta_data: metaRaw.map((entry) => ({
        key: String(entry.key ?? ''),
        value: entry.value,
      })),
    };
  }

  private mapCatalogTxtVariation(p: Record<string, unknown>): CatalogTxtVariation {
    const attributes = Array.isArray(p.attributes) ? (p.attributes as Array<Record<string, unknown>>) : [];
    return {
      id: Number(p.id ?? 0),
      sku: String(p.sku ?? ''),
      price: this.toPriceString(p.price),
      stock_status: String(p.stock_status ?? ''),
      attributes: attributes.map((attribute) => ({
        name: String(attribute.name ?? ''),
        option: String(attribute.option ?? ''),
      })),
    };
  }

  private mapProduct(p: Record<string, unknown>): WooCommerceProduct {
    const taxonomy = (raw: unknown): Array<Record<string, unknown>> =>
      Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];

    const metaRaw = Array.isArray(p.meta_data) ? (p.meta_data as Array<Record<string, unknown>>) : [];

    return {
      id: p.id as number,
      name: p.name as string,
      sku: (p.sku as string) ?? '',
      price: this.toPriceString(p.price),
      stockQuantity: p.stock_quantity as number | null,
      stockStatus: p.stock_status as string,
      description: (p.short_description as string) ?? '',
      status: p.status as string,
      type: p.type ? String(p.type) : undefined,
      permalink: typeof p.permalink === 'string' ? p.permalink : undefined,
      metaData: metaRaw.map((entry) => ({
        key: String(entry.key ?? ''),
        value: entry.value,
      })),
      categories: taxonomy(p.categories).map((c) => ({
        id: Number(c.id ?? 0),
        name: String(c.name ?? ''),
        slug: String(c.slug ?? ''),
      })),
      tags: taxonomy(p.tags).map((t) => String(t.name ?? '')),
      images: taxonomy(p.images)
        .map((image) => String(image.src ?? ''))
        .filter((src) => src.startsWith('http')),
    };
  }
}
