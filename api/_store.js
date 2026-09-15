// Almacen minimo de conversaciones de WhatsApp: quien escribe, que se
// hablo, y si el equipo tomo esa conversacion (pausando al asistente).
//
// Usa Upstash Redis por su API REST (un simple POST con el comando como
// JSON) en vez de un cliente de Redis normal, porque un cliente normal
// necesita una conexion TCP persistente que no funciona bien en una
// funcion serverless que se crea y se destruye en cada peticion.
//
// Variables de entorno necesarias: UPSTASH_REDIS_REST_URL y
// UPSTASH_REDIS_REST_TOKEN (las da Upstash al crear la base de datos).
const BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const TTL_HISTORIAL_SEGUNDOS = 60 * 60 * 24 * 7; // una conversacion "vive" 7 dias sin actividad
const PAUSA_HORAS = 6; // si nadie del equipo la retoma, el asistente se reactiva solo despues de esto

function configurado() {
  return Boolean(BASE && TOKEN);
}

async function comando(partes) {
  const resp = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(partes),
  });
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    throw new Error('Upstash respondio ' + resp.status + ': ' + detalle.slice(0, 200));
  }
  const datos = await resp.json();
  return datos.result;
}

async function obtenerHistorial(numero) {
  const crudo = await comando(['GET', 'wa:hist:' + numero]);
  if (!crudo) return [];
  try {
    const historial = JSON.parse(crudo);
    return Array.isArray(historial) ? historial : [];
  } catch {
    return [];
  }
}

async function guardarHistorial(numero, historial) {
  const recorte = JSON.stringify(historial.slice(-16));
  await comando(['SET', 'wa:hist:' + numero, recorte, 'EX', String(TTL_HISTORIAL_SEGUNDOS)]);
}

async function estaPausado(numero) {
  const valor = await comando(['GET', 'wa:pausa:' + numero]);
  return Boolean(valor);
}

async function pausar(numero) {
  await comando(['SET', 'wa:pausa:' + numero, '1', 'EX', String(PAUSA_HORAS * 3600)]);
}

module.exports = { configurado, obtenerHistorial, guardarHistorial, estaPausado, pausar };
