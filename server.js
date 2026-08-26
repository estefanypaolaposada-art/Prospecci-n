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

async function apolloFetch(endpointPath, body) {
  const response = await fetch(`${APOLLO_BASE_URL}${endpointPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': APOLLO_API_KEY,
    },
    body: JSON.stringify(body),
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
      q_organization_name: companyName,
      page: 1,
      per_page: 1,
    });

    const organization = orgData.organizations?.[0];
    if (!organization) {
      return res.status(404).json({
        error: `No se encontró ninguna organización llamada "${companyName}" en Apollo.`,
      });
    }

    // 2. Buscar personas de esa organización con los cargos objetivo
    const peopleData = await apolloFetch('/mixed_people/search', {
      organization_ids: [organization.id],
      person_titles: TARGET_TITLES,
      page: 1,
      per_page: 25,
    });

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

    const best = ranked[0].person;

    // 3. Enriquecer el mejor contacto para revelar email/teléfono (consume créditos de Apollo)
    let enriched = best;
    try {
      const matchData = await apolloFetch('/people/match', {
        id: best.id,
        reveal_personal_emails: true,
        reveal_phone_number: true,
      });
      if (matchData.person) enriched = matchData.person;
    } catch (enrichErr) {
      console.warn('No se pudo enriquecer el contacto, se usan los datos de la búsqueda:', enrichErr.message);
    }

    const phone =
      enriched.phone_numbers?.[0]?.sanitized_number ||
      enriched.phone_numbers?.[0]?.raw_number ||
      null;

    const email =
      enriched.email && !enriched.email.includes('not_unlocked') ? enriched.email : null;

    return res.json({
      organization: {
        name: organization.name,
        website_url: organization.website_url,
      },
      contact: {
        name: enriched.name || null,
        title: enriched.title || null,
        email,
        phone,
        linkedin_url: enriched.linkedin_url || null,
      },
    });
  } catch (err) {
    console.error('Error consultando Apollo:', err.message);
    const status = err.status && err.status < 500 ? err.status : 502;
    return res.status(status).json({ error: `Error al consultar Apollo.io: ${err.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
