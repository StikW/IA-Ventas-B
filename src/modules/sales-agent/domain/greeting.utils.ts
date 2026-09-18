/** Saludo según hora Colombia (America/Bogota). */

export type TimeOfDayGreeting = 'Buenos días' | 'Buenas tardes' | 'Buenas noches';

const COLOMBIA_TZ = 'America/Bogota';

function getColombiaHour(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: COLOMBIA_TZ,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const hourPart = parts.find((part) => part.type === 'hour');
  return hourPart ? parseInt(hourPart.value, 10) : now.getHours();
}

/** Franjas: días 5–11, tardes 12–18, noches 19–4. */
export function getTimeOfDayGreeting(now: Date = new Date()): TimeOfDayGreeting {
  const hour = getColombiaHour(now);
  if (hour >= 5 && hour <= 11) return 'Buenos días';
  if (hour >= 12 && hour <= 18) return 'Buenas tardes';
  return 'Buenas noches';
}

/** Si el cliente ya saludó con buenos días/tardes/noches, respetarlo. */
export function extractClientTimeGreeting(text: string): TimeOfDayGreeting | null {
  const normalized = text.trim().toLowerCase();
  if (/^buenos\s*d[ií]as\b/.test(normalized)) return 'Buenos días';
  if (/^buenas\s*tardes\b/.test(normalized)) return 'Buenas tardes';
  if (/^buenas\s*noches\b/.test(normalized)) return 'Buenas noches';
  return null;
}

export function resolveGreetingPhrase(userText?: string, now: Date = new Date()): TimeOfDayGreeting {
  const clientGreeting = userText ? extractClientTimeGreeting(userText) : null;
  return clientGreeting ?? getTimeOfDayGreeting(now);
}

export function buildWelcomeIntro(businessName: string, userText?: string, now: Date = new Date()): string {
  const greeting = resolveGreetingPhrase(userText, now);
  return `¡${greeting}! 👋 Qué gusto tenerte en *${businessName}*.`;
}
