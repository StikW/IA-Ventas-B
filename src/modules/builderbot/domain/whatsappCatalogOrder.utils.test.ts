import { describe, expect, it } from 'vitest';
import {
  isWhatsAppCatalogOrderEventText,
  parseWhatsAppCatalogOrder,
} from './whatsappCatalogOrder.utils';

describe('parseWhatsAppCatalogOrder', () => {
  it('extrae retailerId y quantity del payload BBC', () => {
    const parsed = parseWhatsAppCatalogOrder({
      event: 'message.incoming',
      from: '573147311511',
      phone: '573147311511',
      name: 'Dz',
      text: '_event_order__999b8a19-9a0d-4bfd-9df3-18b1812b08df',
      order: {
        source: 'meta',
        catalogId: '1393618712697146',
        products: [
          {
            retailerId: 'ubg0seita5',
            name: 'ubg0seita5',
            price: 600000,
            currency: 'COP',
            quantity: 1,
          },
        ],
        totalAmount: 600000,
        currency: 'COP',
      },
    });

    expect(parsed).toEqual({
      from: '573147311511',
      phone: '573147311511',
      name: 'Dz',
      products: [
        {
          retailerId: 'ubg0seita5',
          quantity: 1,
          name: 'ubg0seita5',
          price: 600000,
          currency: 'COP',
        },
      ],
      catalogId: '1393618712697146',
      totalAmount: 600000,
      currency: 'COP',
    });
  });

  it('usa product_items del raw si products está vacío', () => {
    const parsed = parseWhatsAppCatalogOrder({
      from: '573000000000',
      order: {
        products: [],
        raw: {
          product_items: [{ product_retailer_id: 'SKU-1', quantity: 2, item_price: 100 }],
        },
      },
    });

    expect(parsed?.products).toEqual([
      { retailerId: 'SKU-1', quantity: 2, price: 100, currency: undefined, name: undefined },
    ]);
  });

  it('detecta texto centinela de pedido', () => {
    expect(isWhatsAppCatalogOrderEventText('_event_order__abc')).toBe(true);
    expect(isWhatsAppCatalogOrderEventText('hola')).toBe(false);
  });
});
