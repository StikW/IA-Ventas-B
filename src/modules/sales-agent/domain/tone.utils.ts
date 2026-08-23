/**
 * Calidez y variedad en los textos del agente.
 *
 * El agente repite las mismas frases en cada vuelta del carrito, así que sin variación la
 * conversación suena automática. `pickVariant` deriva la elección de una semilla del propio
 * contenido (nombre del producto, tamaño del carrito): así el mismo contexto produce siempre
 * el mismo texto y las pruebas son reproducibles.
 */

export const EMOJI = {
  cart: '🛒',
  gem: '💎',
  sparkle: '✨',
  pointDown: '👇',
  smile: '😊',
  check: '✅',
  search: '🔍',
  tag: '🏷️',
} as const;

export function pickVariant<T>(options: readonly T[], seed?: string | number): T {
  if (options.length <= 1) return options[0]!;

  const key = seed === undefined ? '' : String(seed);
  if (!key) return options[Math.floor(Math.random() * options.length)]!;

  let hash = 7;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) % 1_000_003;
  }
  return options[hash % options.length]!;
}

const ADDED_OPENERS = ['¡Listo!', '¡Perfecto!', '¡Anotado!', '¡Excelente elección!'] as const;

const OPTIONS_OPENERS = ['¡Claro!', '¡Con gusto!', '¡Mira lo que tenemos!'] as const;

const MORE_PROMPTS = [
  `¿Te muestro algo más o cerramos el pedido? ${EMOJI.smile}`,
  `Si quieres otro producto, mándame su *ID* y lo sumo al pedido ${EMOJI.sparkle}`,
  `¿Agregamos algo más o lo dejamos así? ${EMOJI.smile}`,
] as const;

const NOT_FOUND_OPENERS = [
  'Mmm, no logré identificarlo',
  'No estoy seguro de cuál es',
  'Se me escapa cuál es',
] as const;

/** «¡Listo!», «¡Perfecto!»… para confirmar que algo entró al carrito. */
export function warmAddedOpener(seed?: string | number): string {
  return pickVariant(ADDED_OPENERS, seed);
}

/** Apertura amable de un listado de productos u opciones. */
export function warmOptionsOpener(seed?: string | number): string {
  return pickVariant(OPTIONS_OPENERS, seed);
}

/** Cierre que invita a seguir sin sonar a formulario. */
export function warmMorePrompt(seed?: string | number): string {
  return pickVariant(MORE_PROMPTS, seed);
}

export function warmNotFoundOpener(seed?: string | number): string {
  return pickVariant(NOT_FOUND_OPENERS, seed);
}
