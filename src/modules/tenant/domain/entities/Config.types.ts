export interface BusinessProfileConfig {
  description?: string;
  address?: string;
  businessHours?: string;
  bankAccountInfo?: string;
  /** URL absoluta del formulario de compra WC/MASSI. Default: `{storeUrl}/checkout/` */
  checkoutFormUrl?: string;
  /**
   * `link` (default): tras cerrar carrito → enlace al formulario WC.
   * `whatsapp`: botones de pago en chat (legacy).
   */
  checkoutMode?: 'link' | 'whatsapp';
}

export interface BusinessConfigProps {
  tenantId: string;
  business: BusinessProfileConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  keyHash: string;
  keyPrefix: string;
  createdAt: string;
  revokedAt?: string;
}
