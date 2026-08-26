require('dotenv').config();
const express = require('express');
const path = require('path');

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';

// Cargos que nos interesan (en español e inglés, Apollo hace matching flexible sobre el título)
const TARGET_TITLES = [
  'category manager',
  'trade marketing',
  'mercadeo',
  'marketing',
  'ventas',
  'sales',
];

// Palabras que indican seniority, usadas para elegir el "mejor" contacto entre los que coinciden
const SENIORITY_TIERS = [
  { score: 50, keywords: ['chief', 'cmo', 'cco', 'vicepresidente', 'vice president', 'vp', 'director', 'head'] },
  { score: 30, keywords: ['gerente', 'manager', 'jefe'] },
  { score: 10, keywords: ['coordinador', 'coordinator', 'analista', 'analyst', 'representante', 'representative', 'ejecutivo', 'executive'] },
];

function scoreContact(person) {
  const title = (person.title || '').toLowerCase();
  if (!TARGET_TITLES.some((t) => title.includes(t))) return -1;

  let score = 100;
  for (const tier of SENIORITY_TIERS) {
    if (tier.keywords.some((k) => title.includes(k))) {
      score += tier.score;
      break;
    }
  }
  if (person.email) score += 5;
  if (person.phone_numbers && person.phone_numbers.length) score += 5;
  return score;
}

const APOLLO_DEBUG = process.env.APOLLO_DEBUG === 'true';

function debugLog(label, data) {
  if (!APOLLO_DEBUG) return;
  console.log(`[apollo-debug] ${label}:`, JSON.stringify(data, null, 2));
}

function contactName(person) {
  return person.name || [person.first_name, person.last_name].filter(Boolean).join(' ') || null;
}

// Cuántos contactos como máximo devolvemos (cada uno consume un enriquecimiento/crédito de Apollo)
const MAX_RESULTS = 8;

// Guarda en memoria el estado del teléfono de cada persona (Apollo lo entrega de forma
// asíncrona por webhook). id de Apollo -> { status: 'pending'|'ready'|'unavailable', phone, requestedAt }
// Se pierde si el servidor se reinicia; es suficiente para que el frontend haga polling
// mientras la búsqueda sigue "viva" en el navegador del usuario.
const phoneRequests = new Map();
const PHONE_REQUEST_TTL_MS = 10 * 60 * 1000; // 10 minutos

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of phoneRequests) {
    if (now - entry.requestedAt > PHONE_REQUEST_TTL_MS) phoneRequests.delete(id);
  }
}, 60 * 1000).unref();

function markPhonePending(personId) {
  const existing = phoneRequests.get(personId);
  if (existing?.status === 'ready') return existing;
  const entry = { status: 'pending', phone: null, requestedAt: Date.now() };
  phoneRequests.set(personId, entry);
  return entry;
}

function markPhoneReady(personId, phone) {
  const entry = { status: 'ready', phone, requestedAt: Date.now() };
  phoneRequests.set(personId, entry);
  return entry;
}

// Busca recursivamente objetos con forma { id, phone_numbers: [...] } dentro del payload
// del webhook, ya que Apollo no documenta públicamente un esquema fijo para esta entrega.
function extractPhoneEntries(payload, seen = new Set()) {
  const entries = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node.id === 'string' && Array.isArray(node.phone_numbers)) {
      entries.push({ id: node.id, phone_numbers: node.phone_numbers });
    }
    Object.values(node).forEach(visit);
  };
  visit(payload);
  return entries;
}

// endpointPath: ruta de Apollo. query: parámetros que van en la URL (Apollo los exige así
// para /people/match, incluyendo los flags reveal_personal_emails/reveal_phone_number).
// body: cuerpo JSON, usado por los endpoints de búsqueda (organizations/search, mixed_people/api_search).
async function apolloFetch(endpointPath, { query = {}, body } = {}) {
  const url = new URL(`${APOLLO_BASE_URL}${endpointPath}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': APOLLO_API_KEY,
    },
    body: JSON.stringify(body || {}),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error || data?.message || `Apollo respondió con estado ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }

  return data;
}

const app = express();
// Necesario para que req.protocol refleje "https" cuando la app corre detrás de un proxy
// (Render, Railway, etc.), ya que Apollo exige que webhook_url sea una URL https pública.
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/search', async (req, res) => {
  if (!APOLLO_API_KEY) {
    return res.status(500).json({
      error: 'El servidor no tiene configurada la variable de entorno APOLLO_API_KEY.',
    });
  }

  const companyName = (req.body?.company || '').trim();
  if (!companyName) {
    return res.status(400).json({ error: 'Debes ingresar el nombre de una empresa.' });
  }

  try {
    // 1. Buscar la organización por nombre
    const orgData = await apolloFetch('/organizations/search', {
      body: {
        q_organization_name: companyName,
        page: 1,
        per_page: 1,
      },
    });

    const organization = orgData.organizations?.[0];
    if (!organization) {
      return res.status(404).json({
        error: `No se encontró ninguna organización llamada "${companyName}" en Apollo.`,
      });
    }

    // 2. Buscar personas de esa organización con los cargos objetivo
    // (mixed_people/search quedó deprecado para llamadas de API; Apollo pide usar api_search)
    const peopleData = await apolloFetch('/mixed_people/api_search', {
      body: {
        organization_ids: [organization.id],
        person_titles: TARGET_TITLES,
        page: 1,
        per_page: 50,
      },
    });

    debugLog('respuesta cruda de /mixed_people/api_search', peopleData);

    const people = peopleData.people || [];
    const ranked = people
      .map((person) => ({ person, score: scoreContact(person) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score);

    if (!ranked.length) {
      return res.status(404).json({
        error: `Se encontró "${organization.name}", pero no hay contactos de ventas, trade marketing, mercadeo, marketing o category manager disponibles en Apollo.`,
        organization: { name: organization.name, website_url: organization.website_url },
      });
    }

    const candidates = ranked.slice(0, MAX_RESULTS).map((entry) => entry.person);

    // Apollo exige los parámetros de /people/match en la URL (query string), no en el body,
    // y para revelar el teléfono además exige una webhook_url pública donde lo entrega de forma
    // asíncrona (puede tardar); por eso el teléfono normalmente no viene en esta misma respuesta.
    const webhookUrl = `${req.protocol}://${req.get('host')}/api/apollo-webhook`;

    // 3. Enriquecer cada candidato para revelar email/teléfono (consume créditos de Apollo por cada uno)
    const contacts = [];
    for (const candidate of candidates) {
      let enriched = candidate;
      try {
        const matchData = await apolloFetch('/people/match', {
          query: {
            id: candidate.id,
            first_name: candidate.first_name,
            last_name: candidate.last_name,
            organization_name: organization.name,
            reveal_personal_emails: true,
            reveal_phone_number: true,
            webhook_url: webhookUrl,
          },
        });
        debugLog(`respuesta cruda de /people/match para ${candidate.id}`, matchData);
        if (matchData.person) enriched = matchData.person;
      } catch (enrichErr) {
        console.warn(
          `No se pudo enriquecer el contacto ${candidate.id}, se usan los datos de la búsqueda:`,
          enrichErr.message
        );
      }

      const syncPhone =
        enriched.phone_numbers?.[0]?.sanitized_number ||
        enriched.phone_numbers?.[0]?.raw_number ||
        null;

      // Si Apollo ya lo devolvió en la misma respuesta (o llegó por webhook de una
      // búsqueda anterior de esta misma persona), lo damos por listo de una vez;
      // si no, queda "pending" y el frontend lo consulta en /api/phone/:id.
      const phoneEntry = syncPhone
        ? markPhoneReady(candidate.id, syncPhone)
        : markPhonePending(candidate.id);

      const email =
        enriched.email && !enriched.email.includes('not_unlocked') ? enriched.email : null;

      contacts.push({
        personId: candidate.id,
        name: contactName(enriched),
        title: enriched.title || null,
        email,
        phone: phoneEntry.phone,
        phoneStatus: phoneEntry.status,
        linkedin_url: enriched.linkedin_url || null,
      });
    }

    debugLog('contactos finales devueltos al frontend', contacts);

    return res.json({
      organization: {
        name: organization.name,
        website_url: organization.website_url,
      },
      contacts,
    });
  } catch (err) {
    console.error('Error consultando Apollo:', err.message);
    const status = err.status && err.status < 500 ? err.status : 502;
    return res.status(status).json({ error: `Error al consultar Apollo.io: ${err.message}` });
  }
});

// Apollo entrega los teléfonos revelados aquí de forma asíncrona (ver comentario junto a
// webhook_url más arriba). Guardamos el resultado en memoria (phoneRequests) para que el
// frontend lo recoja haciendo polling a GET /api/phone/:personId.
app.post('/api/apollo-webhook', (req, res) => {
  debugLog('webhook de Apollo recibido (revelación de teléfono)', req.body);

  const entries = extractPhoneEntries(req.body);
  for (const entry of entries) {
    const phone = entry.phone_numbers[0]?.sanitized_number || entry.phone_numbers[0]?.raw_number || null;
    const status = phone ? 'ready' : 'unavailable';
    phoneRequests.set(entry.id, { status, phone, requestedAt: Date.now() });
    debugLog(`teléfono actualizado para ${entry.id}`, phoneRequests.get(entry.id));
  }

  if (!entries.length) {
    debugLog('no se encontraron entradas con id + phone_numbers en el payload del webhook', null);
  }

  res.status(200).json({ received: true });
});

// El frontend consulta esto cada pocos segundos mientras un contacto está "Cargando teléfono...".
app.get('/api/phone/:personId', (req, res) => {
  const entry = phoneRequests.get(req.params.personId);
  if (!entry) {
    return res.json({ status: 'unavailable', phone: null });
  }
  res.json({ status: entry.status, phone: entry.phone });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
