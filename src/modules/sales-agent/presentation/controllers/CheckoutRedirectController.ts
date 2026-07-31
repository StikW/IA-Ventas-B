import { Request, Response, NextFunction } from 'express';
import { container } from 'tsyringe';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { IWooCommerceConfigRepository } from '../../../woocommerce/domain/IWooCommerceService';
import { IChatSessionRepository } from '../../domain/IChatSessionRepository';

/** El botón CTA del flow BBC es fijo, así que la URL se resuelve aquí por teléfono. */
function phoneVariants(raw: string): string[] {
  const digits = raw.replace(/\D/g, '');
  return [...new Set([raw, digits, `+${digits}`])].filter(Boolean);
}

export class CheckoutRedirectController {
  async redirect(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = String(req.params.tenantId ?? '');
      const rawPhone = String(req.params.phone ?? '');

      if (!tenantId || !rawPhone) {
        res.status(400).json({
          error: { code: 'CHECKOUT_LINK_INVALID', message: 'Enlace de compra inválido' },
        });
        return;
      }

      const chatRepo = container.resolve<IChatSessionRepository>('IChatSessionRepository');

      let checkoutUrl: string | undefined;
      for (const phone of phoneVariants(rawPhone)) {
        const session = await chatRepo.find(tenantId, phone);
        checkoutUrl = session?.salesContext?.checkoutUrl;
        if (checkoutUrl) break;
      }

      if (checkoutUrl) {
        res.redirect(302, checkoutUrl);
        return;
      }

      logger.warn({ tenantId, phone: rawPhone }, 'Redirect de checkout sin carrito en sesión');

      const wcRepo = container.resolve<IWooCommerceConfigRepository>('IWooCommerceConfigRepository');
      const wcConfig = await wcRepo.findByTenantId(tenantId);
      const storeUrl = wcConfig?.storeUrl?.replace(/\/$/, '');

      if (storeUrl) {
        res.redirect(302, storeUrl);
        return;
      }

      res.status(404).json({
        error: {
          code: 'CHECKOUT_LINK_EXPIRED',
          message: 'No encontramos tu carrito. Escríbenos por WhatsApp para retomar tu pedido.',
        },
      });
    } catch (err) {
      next(err);
    }
  }
}

export const checkoutRedirectController = new CheckoutRedirectController();
