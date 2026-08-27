const form = document.getElementById('search-form');
const input = document.getElementById('company-input');
const button = document.getElementById('search-button');
const resultArea = document.getElementById('result-area');
const suggestionsList = document.getElementById('suggestions-list');

const SUGGEST_DEBOUNCE_MS = 250;
const SUGGEST_MIN_CHARS = 2;

let selectedOrganizationId = null;
let suggestDebounceTimer = null;
let suggestAbortController = null;
let currentSuggestions = [];
let activeSuggestionIndex = -1;

// Cada consulta a /api/phone/:id vuelve a preguntarle a Apollo (ver server.js). En la
// práctica, si Apollo tiene el número lo confirma en los primeros segundos; si no lo tiene,
// esperar varios minutos solo deja la tarjeta "cargando" sin necesidad. Por eso esperamos
// solo 30s (8 intentos x 4s) antes de mostrar "No disponible".
const PHONE_POLL_INTERVAL_MS = 4000;
const PHONE_POLL_MAX_ATTEMPTS = 8;

let activePhonePolls = [];

function stopAllPhonePolls() {
  activePhonePolls.forEach((intervalId) => clearInterval(intervalId));
  activePhonePolls = [];
}

function renderLoading() {
  stopAllPhonePolls();
  resultArea.innerHTML = '<p class="loading">Buscando en Apollo.io...</p>';
}

function renderError(message) {
  stopAllPhonePolls();
  resultArea.innerHTML = `<div class="error-box">${escapeHtml(message)}</div>`;
}

function phoneFieldHtml(contact) {
  if (contact.phoneStatus === 'pending') {
    return `
      <div class="contact-field contact-field-phone-pending">
        <span class="label">Teléfono</span>
        <span class="value-group">
          <span class="value loading-phone" id="phone-value-${escapeHtml(contact.personId)}">Cargando teléfono...</span>
          <span class="hint" id="phone-hint-${escapeHtml(contact.personId)}">Confirmando con Apollo...</span>
        </span>
      </div>
    `;
  }

  const value = contact.phone;
  return `
    <div class="contact-field">
      <span class="label">Teléfono</span>
      <span class="value ${value ? '' : 'missing'}" id="phone-value-${escapeHtml(contact.personId)}">
        ${value ? escapeHtml(value) : 'No disponible'}
      </span>
    </div>
  `;
}

function renderResult(data) {
  stopAllPhonePolls();

  const { organization, contacts } = data;

  const field = (label, value) =>
    `<div class="contact-field">
       <span class="label">${label}</span>
       <span class="value ${value ? '' : 'missing'}">${value ? escapeHtml(value) : 'No disponible'}</span>
     </div>`;

  const orgHeader = `
    <div class="org-name">${escapeHtml(organization.name)}</div>
    ${organization.website_url ? `<span class="org-website">${escapeHtml(organization.website_url)}</span>` : ''}
  `;

  if (!contacts || !contacts.length) {
    resultArea.innerHTML = `<div class="card">${orgHeader}<p class="loading">No se encontraron contactos.</p></div>`;
    return;
  }

  const contactCards = contacts
    .map(
      (contact) => `
        <div class="card">
          ${field('Nombre', contact.name)}
          ${field('Cargo', contact.title)}
          ${phoneFieldHtml(contact)}
          ${field('Email', contact.email)}
          ${contact.linkedin_url ? field('LinkedIn', contact.linkedin_url) : ''}
        </div>
      `
    )
    .join('');

  resultArea.innerHTML = `
    <div class="card org-card">${orgHeader}</div>
    ${contactCards}
  `;

  contacts
    .filter((contact) => contact.phoneStatus === 'pending' && contact.personId)
    .forEach((contact) => pollPhone(contact.personId));
}

function resolvePhoneField(personId, { text, missing }) {
  const valueEl = document.getElementById(`phone-value-${personId}`);
  if (!valueEl) return;

  valueEl.textContent = text;
  valueEl.classList.remove('loading-phone', 'missing');
  if (missing) valueEl.classList.add('missing');

  const hintEl = document.getElementById(`phone-hint-${personId}`);
  if (hintEl) hintEl.remove();
}

function pollPhone(personId) {
  let attempts = 0;

  const intervalId = setInterval(async () => {
    attempts += 1;
    const valueEl = document.getElementById(`phone-value-${personId}`);

    // La tarjeta ya no está en pantalla (se hizo otra búsqueda); no seguir sondeando.
    if (!valueEl) {
      clearInterval(intervalId);
      return;
    }

    try {
      const response = await fetch(`/api/phone/${encodeURIComponent(personId)}`);
      const data = await response.json();

      if (data.status === 'ready' && data.phone) {
        resolvePhoneField(personId, { text: data.phone, missing: false });
        clearInterval(intervalId);
        return;
      }

      if (data.status === 'unavailable') {
        resolvePhoneField(personId, { text: 'No disponible', missing: true });
        clearInterval(intervalId);
        return;
      }
    } catch (err) {
      // Error de red puntual: seguimos intentando hasta agotar los intentos.
    }

    if (attempts >= PHONE_POLL_MAX_ATTEMPTS) {
      resolvePhoneField(personId, { text: 'No disponible', missing: true });
      clearInterval(intervalId);
    }
  }, PHONE_POLL_INTERVAL_MS);

  activePhonePolls.push(intervalId);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function hideSuggestions() {
  suggestionsList.hidden = true;
  suggestionsList.innerHTML = '';
  currentSuggestions = [];
  activeSuggestionIndex = -1;
}

function setActiveSuggestion(index) {
  const items = suggestionsList.querySelectorAll('.suggestion-item');
  items.forEach((item, i) => item.classList.toggle('active', i === index));
  activeSuggestionIndex = index;
}

function selectSuggestion(org) {
  input.value = org.name;
  selectedOrganizationId = org.id;
  hideSuggestions();
  form.requestSubmit();
}

function renderSuggestions(organizations) {
  currentSuggestions = organizations;
  activeSuggestionIndex = -1;
  suggestionsList.innerHTML = '';

  if (!organizations.length) {
    hideSuggestions();
    return;
  }

  organizations.forEach((org) => {
    const li = document.createElement('li');
    li.className = 'suggestion-item';

    if (org.logoUrl) {
      const img = document.createElement('img');
      img.className = 'suggestion-logo';
      img.src = org.logoUrl;
      img.alt = '';
      img.addEventListener('error', () => {
        img.replaceWith(logoFallback(org.name));
      });
      li.appendChild(img);
    } else {
      li.appendChild(logoFallback(org.name));
    }

    const textWrap = document.createElement('div');
    textWrap.className = 'suggestion-text';

    const nameEl = document.createElement('div');
    nameEl.className = 'suggestion-name';
    nameEl.textContent = org.name;
    textWrap.appendChild(nameEl);

    if (org.websiteUrl) {
      const websiteEl = document.createElement('div');
      websiteEl.className = 'suggestion-website';
      websiteEl.textContent = org.websiteUrl;
      textWrap.appendChild(websiteEl);
    }

    li.appendChild(textWrap);
    li.addEventListener('mousedown', (event) => {
      // mousedown (no click) para que dispare antes del blur del input.
      event.preventDefault();
      selectSuggestion(org);
    });

    suggestionsList.appendChild(li);
  });

  suggestionsList.hidden = false;
}

function logoFallback(name) {
  const div = document.createElement('div');
  div.className = 'suggestion-logo-fallback';
  div.textContent = (name || '?').trim().charAt(0).toUpperCase();
  return div;
}

async function fetchSuggestions(query) {
  if (suggestAbortController) suggestAbortController.abort();
  suggestAbortController = new AbortController();

  try {
    const response = await fetch(`/api/organizations/suggest?q=${encodeURIComponent(query)}`, {
      signal: suggestAbortController.signal,
    });
    const data = await response.json();
    // El texto pudo cambiar mientras esperábamos la respuesta; no pisar lo que el usuario ya escribió después.
    if (input.value.trim() === query) {
      renderSuggestions(data.organizations || []);
    }
  } catch (err) {
    if (err.name !== 'AbortError') hideSuggestions();
  }
}

input.addEventListener('input', () => {
  selectedOrganizationId = null;
  const query = input.value.trim();

  clearTimeout(suggestDebounceTimer);
  if (query.length < SUGGEST_MIN_CHARS) {
    hideSuggestions();
    return;
  }

  suggestDebounceTimer = setTimeout(() => fetchSuggestions(query), SUGGEST_DEBOUNCE_MS);
});

input.addEventListener('keydown', (event) => {
  if (suggestionsList.hidden || !currentSuggestions.length) return;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    setActiveSuggestion((activeSuggestionIndex + 1) % currentSuggestions.length);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    setActiveSuggestion((activeSuggestionIndex - 1 + currentSuggestions.length) % currentSuggestions.length);
  } else if (event.key === 'Enter' && activeSuggestionIndex >= 0) {
    event.preventDefault();
    selectSuggestion(currentSuggestions[activeSuggestionIndex]);
  } else if (event.key === 'Escape') {
    hideSuggestions();
  }
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.search-input-wrap')) hideSuggestions();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideSuggestions();
  const company = input.value.trim();
  if (!company) return;

  button.disabled = true;
  renderLoading();

  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company, organizationId: selectedOrganizationId || undefined }),
    });

    const data = await response.json();

    if (!response.ok) {
      renderError(data.error || 'Ocurrió un error inesperado.');
      return;
    }

    renderResult(data);
  } catch (err) {
    renderError('No se pudo conectar con el servidor. Intenta de nuevo.');
  } finally {
    button.disabled = false;
  }
});
