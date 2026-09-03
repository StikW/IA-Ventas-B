import { OrderItem } from '../../../commerce/domain/entities/Order.types';
import { CartTargetSpec, findBestCartMatch, findCartMatches } from '../../domain/cartModification.utils';
import { PendingCartItem } from '../../domain/IChatSessionRepository';

/** Operaciones de carrito (única fuente de verdad por SKU). */
export class CartService {
  static merge(existing: PendingCartItem[] | undefined, newItems: OrderItem[]): PendingCartItem[] {
    const cart: PendingCartItem[] = [...(existing ?? [])];
    for (const item of newItems) {
      const idx = cart.findIndex(
        (row) => row.sku === item.sku && (row.packUnits ?? 0) === (item.packUnits ?? 0)
      );
      if (idx >= 0) {
        cart[idx] = { ...cart[idx], quantity: cart[idx].quantity + item.quantity };
      } else {
        cart.push({ ...item });
      }
    }
    return cart;
  }

  static setQuantity(items: PendingCartItem[], sku: string, quantity: number): PendingCartItem[] {
    const cart = [...items];
    const idx = cart.findIndex((row) => row.sku === sku);
    if (idx < 0) return cart;
    if (quantity <= 0) {
      cart.splice(idx, 1);
      return cart;
    }
    cart[idx] = { ...cart[idx], quantity };
    return cart;
  }

  static setQuantityByTarget(items: PendingCartItem[], target: CartTargetSpec, quantity: number): PendingCartItem[] {
    const match = findBestCartMatch(items, target);
    if (!match) return items;
    return CartService.setQuantity(items, match.sku, quantity);
  }

  static removeByTarget(
    items: PendingCartItem[],
    target: CartTargetSpec,
    quantityToRemove: number,
    removeAllMatching = false
  ): { items: PendingCartItem[]; removedNames: string[]; removedQty: number } {
    const matches = findCartMatches(items, target);
    if (!matches.length) {
      return { items, removedNames: [], removedQty: 0 };
    }

    if (removeAllMatching || quantityToRemove >= 99) {
      const skus = new Set(matches.map((row) => row.sku));
      let removedQty = 0;
      const removedNames: string[] = [];
      const cart = items.filter((row) => {
        if (!skus.has(row.sku)) return true;
        removedQty += row.quantity;
        removedNames.push(row.name);
        return false;
      });
      return { items: cart, removedNames, removedQty };
    }

    const cart = [...items];
    let remaining = quantityToRemove;
    const removedNames: string[] = [];
    let removedQty = 0;

    for (const match of matches) {
      if (remaining <= 0) break;
      const idx = cart.findIndex((row) => row.sku === match.sku);
      if (idx < 0) continue;

      const row = cart[idx]!;
      const take = Math.min(remaining, row.quantity);
      removedQty += take;
      remaining -= take;
      removedNames.push(row.name);

      if (take >= row.quantity) {
        cart.splice(idx, 1);
      } else {
        cart[idx] = { ...row, quantity: row.quantity - take };
      }
    }

    return { items: cart, removedNames, removedQty };
  }

  static clear(): PendingCartItem[] {
    return [];
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

  static findByTarget(items: PendingCartItem[], target: CartTargetSpec): PendingCartItem | undefined {
    return findBestCartMatch(items, target);
  }
}
