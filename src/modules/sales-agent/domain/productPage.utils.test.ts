import { describe, expect, it } from 'vitest';
import {
  formatProductPageLink,
  isProductPageInfoIntent,
  isProductPageSendNowIntent,
  stripProductPageWords,
} from './productPage.utils';

describe('isProductPageInfoIntent', () => {
  it('reconoce las formas en que el cliente pide ver el producto', () => {
    expect(isProductPageInfoIntent('quiero más info')).toBe(true);
    expect(isProductPageInfoIntent('info 3')).toBe(true);
    expect(isProductPageInfoIntent('me mandas fotos?')).toBe(true);
    expect(isProductPageInfoIntent('el link')).toBe(true);
    expect(isProductPageInfoIntent('cómo se ve?')).toBe(true);
  });

  it('no confunde el cierre del pedido con una petición de ficha', () => {
    expect(isProductPageInfoIntent('finalizar pedido')).toBe(false);
    expect(isProductPageInfoIntent('completar la compra')).toBe(false);
  });

  it('"info" suelto solo cuenta si señala un producto', () => {
    expect(isProductPageInfoIntent('info DJVMIL001')).toBe(true);
    expect(isProductPageInfoIntent('info')).toBe(true);
    expect(isProductPageInfoIntent('me das información de los envíos?')).toBe(false);
    expect(isProductPageInfoIntent('quiero información sobre pagos')).toBe(false);
  });

  // El cliente copia el ID que el agente resalta en negrita y lo reenvía con asteriscos.
  it('acepta el ID con el formato de negrita de WhatsApp', () => {
    expect(isProductPageInfoIntent('info *HRPALM001*')).toBe(true);
    expect(isProductPageInfoIntent('info B')).toBe(true);
  });

  it('distingue "mándamelo ya" de "cuéntame más"', () => {
    expect(isProductPageSendNowIntent('mándame el link')).toBe(true);
    expect(isProductPageSendNowIntent('quiero más info')).toBe(false);
  });
});

describe('stripProductPageWords', () => {
  it('deja solo la referencia al producto', () => {
    expect(stripProductPageWords('info B')).toBe('B');
    expect(stripProductPageWords('info *HRPALM001*')).toBe('HRPALM001');
    expect(stripProductPageWords('mándame fotos de la H')).toBe('de la H');
    expect(stripProductPageWords('quiero más info del 3')).toBe('del 3');
  });
});

describe('formatProductPageLink', () => {
  const url = 'https://massijoyeria.com/producto/dije-buho/';

  it('se sostiene como texto suelto cuando la foto no llega', () => {
    const body = formatProductPageLink('Dije Búho Plano', {
      url,
      price: '110700',
      description: '<p>Dije de <strong>búho</strong> en oro nacional amarillo.</p>',
    });

    expect(body).toContain('*Dije Búho Plano*');
    expect(body).toContain('Precio: $110.700');
    expect(body).toContain('Dije de búho en oro nacional amarillo.');
    expect(body).toContain(url);
  });

  it('omite el precio cuando WooCommerce no lo expone', () => {
    const body = formatProductPageLink('Topos Libélula', { url });
    expect(body).not.toContain('Precio:');
    expect(body).toContain(url);
  });

  it('recorta descripciones largas sin cortar a mitad de frase', () => {
    const description = `${'Pieza artesanal de oro nacional amarillo. '.repeat(10)}`;
    const body = formatProductPageLink('Dije Mariposa', { url, description });
    expect(body).toContain('…');
    expect(body.length).toBeLessThan(400);
  });

  it('acepta la URL suelta para las llamadas antiguas', () => {
    expect(formatProductPageLink('Dije Búho Plano', url)).toContain(url);
  });
});
