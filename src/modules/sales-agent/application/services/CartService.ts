import { OrderItem } from '../../../commerce/domain/entities/Order.types';
import { PendingCartItem } from '../../domain/IChatSessionRepository';

/** Operaciones de carrito (única fuente de verdad por SKU). */
export class CartService {
  static merge(existing: PendingCartItem[] | undefined, newItems: OrderItem[]): PendingCartItem[] {
    const cart: PendingCartItem[] = [...(existing ?? [])];
    for (const item of newItems) {
      const idx = cart.findIndex((row) => row.sku === item.sku);
      if (idx >= 0) {
        cart[idx] = { ...cart[idx], quantity: cart[idx].quantity + item.quantity };
      } else {
        cart.push({ ...item });
      }
    }
    return cart;
  }

  static total(items: PendingCartItem[] | undefined): number {
    return (items ?? []).reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  }

  static isEmpty(items: PendingCartItem[] | undefined): boolean {
    return !items?.length;
  }

  static formatSummary(items: PendingCartItem[]): string {
    const lines = items.map(
      (item) => `· ${item.name} x${item.quantity} — $${(item.unitPrice * item.quantity).toLocaleString('es-CO')}`
    );
    const total = CartService.total(items);
    return [...lines, `\n*Total:* $${total.toLocaleString('es-CO')}`].join('\n');
  }
}
