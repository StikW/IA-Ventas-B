import { describe, expect, it } from 'vitest';
import { resolveStoreCatalogUrl } from './catalogUrl.utils';
import { isCartClearIntent } from './cartModification.utils';

describe('catalogUrl.utils', () => {
  it('usa shopPagePath de WooCommerce (MASSI /tienda/)', () => {
    expect(resolveStoreCatalogUrl('https://massijoyeria.com', '/tienda/')).toBe('https://massijoyeria.com/tienda/');
  });

  it('fallback a /shop/ si no hay ruta detectada', () => {
    expect(resolveStoreCatalogUrl('https://example.com')).toBe('https://example.com/shop/');
  });
});

describe('isCartClearIntent', () => {
  it('detecta quisiera eliminar mi carrito', () => {
    expect(isCartClearIntent('Quisiera eliminar mi carrito')).toBe(true);
  });

  it('detecta vaciar carrito', () => {
    expect(isCartClearIntent('vaciar carrito')).toBe(true);
  });

  it('no confunde quitar un producto específico', () => {
    expect(isCartClearIntent('eliminar anillo talla 6')).toBe(false);
  });
});
