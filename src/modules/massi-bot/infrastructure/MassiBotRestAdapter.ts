import http from 'node:http';
import https from 'node:https';
import { injectable } from 'tsyringe';
import { env } from '../../../shared/infrastructure/config/env';
import { DomainError } from '../../../shared/domain/errors/DomainError';
import { WooCommerceConfigData } from '../../woocommerce/domain/IWooCommerceService';
import {
  IMassiBotService,
  MassiBotClientProfile,
  MassiBotCreateOrderInput,
  MassiBotOrderSummary,
  MassiBotPaymentReportInput,
  MassiBotPaymentReportResult,
  MassiBotVariation,
} from '../domain/IMassiBotService';

const localDevHttpsAgent = new https.Agent({ rejectUnauthorized: false });

@injectable()
export class MassiBotRestAdapter implements IMassiBotService {
  isConfigured(config: WooCommerceConfigData): boolean {
    return !!(config.storeUrl && config.botApiUser?.trim() && config.botApiPassword?.trim());
  }

  async ping(config: WooCommerceConfigData): Promise<boolean> {
    // /ping es público; /clients exige Application Password válida.
    await this.request(config, 'GET', '/clients?phone=0');
    return true;
  }

  async findClientByPhone(config: WooCommerceConfigData, phone: string): Promise<MassiBotClientProfile> {
    const res = await this.request<{ data: MassiBotClientProfile }>(
      config,
      'GET',
      `/clients?phone=${encodeURIComponent(phone)}`
    );
    return res.data;
  }

  async listOrdersByPhone(config: WooCommerceConfigData, phone: string, limit = 5): Promise<MassiBotOrderSummary[]> {
    const res = await this.request<{ data: MassiBotOrderSummary[] }>(
      config,
      'GET',
      `/orders?phone=${encodeURIComponent(phone)}&limit=${limit}`
    );
    return res.data;
  }

  async getProductVariations(config: WooCommerceConfigData, productId: number): Promise<MassiBotVariation[]> {
    const res = await this.request<{ data: MassiBotVariation[] }>(
      config,
      'GET',
      `/products/${productId}/variations`
    );
    return res.data;
  }

  async createOrder(config: WooCommerceConfigData, input: MassiBotCreateOrderInput): Promise<MassiBotOrderSummary> {
    const res = await this.request<{ data: MassiBotOrderSummary }>(config, 'POST', '/orders', {
      body: {
        phone: input.phone,
        customer_name: input.customerName,
        payment_method: input.paymentMethod,
        delivery_type: input.deliveryType ?? 'pickup',
        line_items: input.lineItems.map((item) => ({
          product_id: item.productId,
          variation_id: item.variationId ?? 0,
          quantity: item.quantity,
        })),
      },
      idempotencyKey: input.idempotencyKey,
    });
    return res.data;
  }

  async submitPaymentReport(
    config: WooCommerceConfigData,
    input: MassiBotPaymentReportInput
  ): Promise<MassiBotPaymentReportResult> {
    const res = await this.request<{ data: MassiBotPaymentReportResult }>(
      config,
      'POST',
      `/orders/${input.orderId}/payment-report`,
      {
        body: {
          phone: input.phone,
          proof_url: input.proofUrl,
          amount: input.amount,
          note: input.note,
        },
      }
    );
    return res.data;
  }

  private baseUrl(config: WooCommerceConfigData): string {
    return config.storeUrl.replace(/\/$/, '') + '/wp-json/massi-bot/v1';
  }

  private isLocalDevStore(storeUrl: string): boolean {
    try {
      const { hostname } = new URL(storeUrl);
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local');
    } catch {
      return false;
    }
  }

  private authHeader(config: WooCommerceConfigData): string {
    const user = config.botApiUser!.trim();
    const pass = config.botApiPassword!.trim();
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }

  private async request<T>(
    config: WooCommerceConfigData,
    method: string,
    path: string,
    options?: { body?: unknown; idempotencyKey?: string }
  ): Promise<T> {
    if (!this.isConfigured(config)) {
      throw new DomainError('MASSI Bot API no configurada (usuario/contraseña de aplicación)', 'MASSI_BOT_NOT_CONFIGURED');
    }

    const url = `${this.baseUrl(config)}${path}`;
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const body = options?.body ? JSON.stringify(options.body) : undefined;

    const headers: Record<string, string> = {
      Authorization: this.authHeader(config),
      Accept: 'application/json',
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    if (options?.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    const useInsecureLocalTls =
      isHttps && env.NODE_ENV !== 'production' && this.isLocalDevStore(config.storeUrl);

    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method,
          headers,
          agent: useInsecureLocalTls ? localDevHttpsAgent : undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk as Buffer));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 500;
            if (status < 200 || status >= 300) {
              reject(new DomainError(`MASSI Bot API error ${status}: ${text}`, 'MASSI_BOT_ERROR'));
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              reject(new DomainError('Respuesta inválida de MASSI Bot API', 'MASSI_BOT_ERROR'));
            }
          });
        }
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}
