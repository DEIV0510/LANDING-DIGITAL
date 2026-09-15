// Backend del asistente virtual de Landing Digital.
// Funcion serverless de Vercel: unico lugar que toca la API de Anthropic,
// la clave nunca sale de aqui hacia el navegador.
const { SYSTEM_PROMPT, RESUMEN_TOOL } = require('./_knowledge.js');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TURNOS = 16; // mensajes (usuario+asistente) que se reenvian como contexto
const MAX_LARGO_MSG = 800; // caracteres por mensaje
const MAX_TOKENS_RESPUESTA = 500;

// Limite de uso muy simple, en memoria del propio proceso. Una funcion
// serverless puede tener varias instancias vivas a la vez y se reinicia en
// cada cold start, asi que esto NO es un limite estricto por IP: es una
// segunda barrera ademas de la validacion de tamano, para frenar un abuso
// obvio (alguien disparando decenas de mensajes seguidos). Un limite real
// y compartido entre instancias necesita un almacen externo, por ejemplo
// Upstash Redis.
const intentos = new Map();
const VENTANA_MS = 60_000;
const MAX_POR_VENTANA = 12;

function limitado(ip) {
  const ahora = Date.now();
  if (intentos.size > 500) {
    for (const [clave, valor] of intentos) {
      if (ahora - valor.inicio > VENTANA_MS) intentos.delete(clave);
    }
  }
  const previo = intentos.get(ip);
  if (!previo || ahora - previo.inicio > VENTANA_MS) {
    intentos.set(ip, { inicio: ahora, conteo: 1 });
    return false;
  }
  previo.conteo++;
  return previo.conteo > MAX_POR_VENTANA;
}

function validarMensajes(mensajes) {
  if (!Array.isArray(mensajes) || mensajes.length === 0) return 'Falta la conversacion.';
  if (mensajes.length > MAX_TURNOS) return 'La conversacion es demasiado larga.';
  for (const m of mensajes) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'Mensaje con formato invalido.';
    if (typeof m.content !== 'string' || !m.content.trim()) return 'Mensaje vacio.';
    if (m.content.length > MAX_LARGO_MSG) return 'Un mensaje es demasiado largo.';
  }
  if (mensajes[mensajes.length - 1].role !== 'user') return 'El ultimo mensaje debe ser del visitante.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Metodo no permitido.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[chat] Falta ANTHROPIC_API_KEY en las variables de entorno de Vercel.');
    return res.status(503).json({ error: 'El asistente no esta configurado todavia.' });
  }

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'desconocida').split(',')[0].trim();
  if (limitado(ip)) {
    return res.status(429).json({ error: 'Demasiados mensajes seguidos. Espera un momento.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'JSON invalido.' });
    }
  }

  const mensajes = body && body.mensajes;
  const error = validarMensajes(mensajes);
  if (error) return res.status(400).json({ error });

  const mensajesRecortados = mensajes.slice(-MAX_TURNOS);

  try {
    const respuesta = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS_RESPUESTA,
        temperature: 0.5,
        system: SYSTEM_PROMPT,
        tools: [RESUMEN_TOOL],
        messages: mensajesRecortados.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!respuesta.ok) {
      const detalle = await respuesta.text().catch(() => '');
      console.error('[chat] Anthropic respondio', respuesta.status, detalle.slice(0, 300));
      return res.status(502).json({ error: 'El asistente no pudo responder. Intenta de nuevo.' });
    }

    const datos = await respuesta.json();
    const bloques = datos.content || [];
    const texto = bloques
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const bloqueResumen = bloques.find((b) => b.type === 'tool_use' && b.name === 'guardar_resumen_proyecto');

    if (bloqueResumen) {
      return res.status(200).json({ tipo: 'resumen', texto, resumen: bloqueResumen.input });
    }
    return res.status(200).json({
      tipo: 'mensaje',
      texto: texto || 'No tengo una respuesta clara para eso, ¿puedes contarme un poco mas?',
    });
  } catch (e) {
    console.error('[chat] Error de red hacia Anthropic:', e.message);
    return res.status(502).json({ error: 'No pude conectar con el asistente. Intenta de nuevo en un momento.' });
  }
};
