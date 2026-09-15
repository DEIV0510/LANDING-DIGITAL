// Webhook de WhatsApp (API oficial de Meta / WhatsApp Business Platform).
// Recibe los mensajes que llegan al numero real del negocio, le pregunta al
// mismo asistente que usa el sitio (con un prompt propio para este canal) y
// responde por la misma API. Si el asistente decide que hace falta una
// persona, pausa este numero y avisa.
//
// Variables de entorno necesarias en Vercel:
//   ANTHROPIC_API_KEY          (la misma que ya usa api/chat.js)
//   WHATSAPP_VERIFY_TOKEN      (la inventas tu; se configura tambien en Meta)
//   WHATSAPP_ACCESS_TOKEN      (la da Meta al crear la app de WhatsApp)
//   WHATSAPP_PHONE_NUMBER_ID   (la da Meta, identifica el numero emisor)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (ver api/_store.js)
const { SYSTEM_PROMPT_WHATSAPP, DERIVAR_TOOL } = require('./_knowledge.js');
const store = require('./_store.js');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS_RESPUESTA = 500;
const GRAPH_VERSION = 'v21.0';
const MAX_LARGO_MSG = 800;

async function enviarWhatsApp(numeroDestino, texto) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: numeroDestino,
      type: 'text',
      text: { body: texto },
    }),
  });
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    console.error('[whatsapp] Error enviando mensaje:', resp.status, detalle.slice(0, 300));
  }
}

async function preguntarIA(historial) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
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
      system: SYSTEM_PROMPT_WHATSAPP,
      tools: [DERIVAR_TOOL],
      messages: historial.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!respuesta.ok) {
    const detalle = await respuesta.text().catch(() => '');
    console.error('[whatsapp] Anthropic respondio', respuesta.status, detalle.slice(0, 300));
    return null;
  }
  const datos = await respuesta.json();
  const bloques = datos.content || [];
  const texto = bloques.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const derivarBloque = bloques.find((b) => b.type === 'tool_use' && b.name === 'derivar_a_humano');
  return { texto, derivar: derivarBloque ? derivarBloque.input : null };
}

module.exports = async (req, res) => {
  // Meta verifica el webhook con un GET la primera vez que lo configuras
  // en el panel de WhatsApp > Configuration.
  if (req.method === 'GET') {
    const modo = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const reto = req.query['hub.challenge'];
    if (modo === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(reto);
    }
    return res.status(403).send('Token de verificacion invalido.');
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  // Meta espera un 200 rapido y reintenta el webhook si no lo recibe (o si
  // responde con error), asi que cualquier fallo se registra en el log pero
  // igual se contesta 200 para no entrar en un bucle de reintentos.
  try {
    if (!process.env.ANTHROPIC_API_KEY || !store.configurado()) {
      console.error('[whatsapp] Faltan variables de entorno (ANTHROPIC_API_KEY y/o Upstash).');
      return res.status(200).end();
    }

    const valorCambio = req.body?.entry?.[0]?.changes?.[0]?.value;
    const mensaje = valorCambio?.messages?.[0];

    // Los webhooks de WhatsApp tambien notifican estados de entrega
    // ("delivered", "read"), no solo mensajes nuevos: se ignoran.
    if (!mensaje || mensaje.type !== 'text') {
      return res.status(200).end();
    }

    const numero = mensaje.from;
    const texto = (mensaje.text?.body || '').trim().slice(0, MAX_LARGO_MSG);
    if (!numero || !texto) return res.status(200).end();

    if (await store.estaPausado(numero)) {
      // El equipo tomo esta conversacion: el asistente no responde.
      return res.status(200).end();
    }

    const historialPrevio = await store.obtenerHistorial(numero);
    const historial = [...historialPrevio, { role: 'user', content: texto }].slice(-16);

    const resultado = await preguntarIA(historial);
    if (!resultado) return res.status(200).end();

    if (resultado.texto) {
      historial.push({ role: 'assistant', content: resultado.texto });
      await enviarWhatsApp(numero, resultado.texto);
    }
    await store.guardarHistorial(numero, historial);

    if (resultado.derivar) {
      await store.pausar(numero);
      // Mejora futura: notificar al equipo (correo, Slack, otro numero
      // interno) en vez de solo dejarlo en el log de Vercel.
      console.log('[whatsapp] Conversacion derivada a humano:', numero, JSON.stringify(resultado.derivar));
    }

    return res.status(200).end();
  } catch (e) {
    console.error('[whatsapp] Error procesando webhook:', e.message);
    return res.status(200).end();
  }
};
