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

@injectable()
export class WooCommerceRestAdapter implements IWooCommerceService {
  private baseUrl(config: WooCommerceConfigData): string {
    return config.storeUrl.replace(/\/$/, '') + '/wp-json/wc/v3';
  }

  private authHeader(config: WooCommerceConfigData): string {
    const token = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
    return `Basic ${token}`;
  }

  private async request<T>(config: WooCommerceConfigData, path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl(config)}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.authHeader(config),
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new DomainError(`WooCommerce error ${response.status}: ${body}`, 'WOOCOMMERCE_ERROR');
    }

    return response.json() as Promise<T>;
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
    };
  }
}
