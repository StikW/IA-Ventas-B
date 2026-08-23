import { describe, expect, it } from 'vitest';
import { whatsappSessionPhoneCandidates } from './builderBotPhone';

describe('whatsappSessionPhoneCandidates', () => {
  it('añade el 57 cuando el checkout manda 10 dígitos', () => {
    expect(whatsappSessionPhoneCandidates('3103534207')).toEqual(['3103534207', '573103534207']);
  });

  it('prueba sin indicativo cuando la sesión llegó con 57', () => {
    expect(whatsappSessionPhoneCandidates('+57 310 353 4207')).toEqual(['573103534207', '3103534207']);
  });

  it('no duplica el número ya normalizado', () => {
    expect(whatsappSessionPhoneCandidates('573103534207')).toEqual(['573103534207', '3103534207']);
  });
});
