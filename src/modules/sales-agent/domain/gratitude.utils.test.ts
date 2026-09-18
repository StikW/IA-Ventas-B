import { describe, expect, it } from 'vitest';
import { buildGratitudeReply, isPureGratitude, stripGratitudeForProcessing } from './gratitude.utils';

describe('isPureGratitude', () => {
  it('reconoce agradecimientos simples', () => {
    expect(isPureGratitude('gracias')).toBe(true);
    expect(isPureGratitude('mil gracias')).toBe(true);
    expect(isPureGratitude('muchas gracias por la info')).toBe(true);
    expect(isPureGratitude('ok gracias')).toBe(true);
  });

  it('no trata un pedido como agradecimiento puro', () => {
    expect(isPureGratitude('gracias, agrégame el A')).toBe(false);
    expect(isPureGratitude('quiero el balín #6 gracias')).toBe(false);
    expect(isPureGratitude('quiero una cadena')).toBe(false);
  });
});

describe('stripGratitudeForProcessing', () => {
  it('quita el agradecimiento y deja la instrucción', () => {
    expect(stripGratitudeForProcessing('gracias, agrégame el A')).toEqual({
      stripped: 'agrégame el A',
      hadGratitude: true,
    });
    expect(stripGratitudeForProcessing('mil gracias quiero el balín #6')).toEqual({
      stripped: 'quiero el balín #6',
      hadGratitude: true,
    });
    expect(stripGratitudeForProcessing('agrégame el A, gracias')).toEqual({
      stripped: 'agrégame el A',
      hadGratitude: true,
    });
  });
});

describe('buildGratitudeReply', () => {
  it('responde según el paso del flujo', () => {
    expect(buildGratitudeReply({ phase: 'browsing', flowStep: 'discovery' }).body).toMatch(/ID/);
    expect(
      buildGratitudeReply({
        phase: 'browsing',
        flowStep: 'buying',
        cartItems: [{ productId: 1, sku: 'A', name: 'Anillo', quantity: 1, unitPrice: 1000 }],
      }).uiRoute
    ).toBe('finalize');
    expect(
      buildGratitudeReply({
        phase: 'browsing',
        flowStep: 'checkout_redirect',
        lastCheckoutUrl: 'https://tienda.test/checkout',
      }).body
    ).toContain('https://tienda.test/checkout');
    expect(buildGratitudeReply({ phase: 'awaiting_payment' }).body).toMatch(/comprobante/i);
  });
});
