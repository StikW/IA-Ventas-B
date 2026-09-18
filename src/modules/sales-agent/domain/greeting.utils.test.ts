import { describe, expect, it } from 'vitest';
import {
  buildWelcomeIntro,
  extractClientTimeGreeting,
  getTimeOfDayGreeting,
  resolveGreetingPhrase,
} from './greeting.utils';

describe('getTimeOfDayGreeting', () => {
  it('usa franjas horarias de Colombia', () => {
    expect(getTimeOfDayGreeting(new Date('2026-09-17T10:00:00-05:00'))).toBe('Buenos días');
    expect(getTimeOfDayGreeting(new Date('2026-09-17T14:30:00-05:00'))).toBe('Buenas tardes');
    expect(getTimeOfDayGreeting(new Date('2026-09-17T20:00:00-05:00'))).toBe('Buenas noches');
    expect(getTimeOfDayGreeting(new Date('2026-09-17T03:00:00-05:00'))).toBe('Buenas noches');
  });
});

describe('extractClientTimeGreeting', () => {
  it('detecta el saludo del cliente al inicio del mensaje', () => {
    expect(extractClientTimeGreeting('Buenas tardes')).toBe('Buenas tardes');
    expect(extractClientTimeGreeting('buenos días, quiero una cadena')).toBe('Buenos días');
    expect(extractClientTimeGreeting('hola')).toBeNull();
  });
});

describe('resolveGreetingPhrase', () => {
  it('no contradice al cliente si ya saludó con hora del día', () => {
    const morning = new Date('2026-09-17T09:00:00-05:00');
    expect(resolveGreetingPhrase('buenas tardes', morning)).toBe('Buenas tardes');
    expect(resolveGreetingPhrase('hola', morning)).toBe('Buenos días');
  });
});

describe('buildWelcomeIntro', () => {
  it('arma el bloque de bienvenida con el saludo resuelto', () => {
    const intro = buildWelcomeIntro('MASSI Joyería', 'hola', new Date('2026-09-17T09:00:00-05:00'));
    expect(intro).toContain('¡Buenos días!');
    expect(intro).toContain('*MASSI Joyería*');
  });
});
