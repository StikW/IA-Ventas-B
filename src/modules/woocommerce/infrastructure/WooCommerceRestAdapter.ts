import http from 'node:http';
import https from 'node:https';
import { injectable } from 'tsyringe';
import {
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
    const { status, body } = await this.httpRequest(url, init);

    if (status < 200 || status >= 300) {
      throw new DomainError(`WooCommerce error ${status}: ${body}`, 'WOOCOMMERCE_ERROR');
    }

    return JSON.parse(body) as T;
  }

  async testConnection(config: WooCommerceConfigData): Promise<boolean> {
    await this.request(config, '/products?per_page=1');
    return true;
  }

  async listProducts(config: WooCommerceConfigData, page = 1): Promise<WooCommerceProduct[]> {
    const products = await this.request<Array<Record<string, unknown>>>(
      config,
      `/products?per_page=50&page=${page}&status=publish`
    );

    return products.map((p) => this.mapProduct(p));
  }

  async searchProducts(config: WooCommerceConfigData, query: string): Promise<WooCommerceProduct[]> {
    const q = query.trim();
    if (!q) return [];

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

  private mapProduct(p: Record<string, unknown>): WooCommerceProduct {
    return {
      id: p.id as number,
      name: p.name as string,
      sku: (p.sku as string) ?? '',
      price: p.price as string,
      stockQuantity: p.stock_quantity as number | null,
      stockStatus: p.stock_status as string,
      description: (p.short_description as string) ?? '',
      status: p.status as string,
      type: p.type ? String(p.type) : undefined,
    };
  }
}
