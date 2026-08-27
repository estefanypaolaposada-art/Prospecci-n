const form = document.getElementById('search-form');
const input = document.getElementById('company-input');
const button = document.getElementById('search-button');
const resultArea = document.getElementById('result-area');

// Cada consulta a /api/phone/:id vuelve a preguntarle a Apollo (ver server.js), así que no
// conviene sondear demasiado seguido. Apollo documenta que el teléfono puede tardar "varios
// minutos" en resolverse, así que esperamos hasta 3 minutos (22 intentos x 8s).
const PHONE_POLL_INTERVAL_MS = 8000;
const PHONE_POLL_MAX_ATTEMPTS = 22;

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
      <div class="contact-field">
        <span class="label">Teléfono</span>
        <span class="value loading-phone" id="phone-value-${escapeHtml(contact.personId)}">Cargando teléfono...</span>
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
        valueEl.textContent = data.phone;
        valueEl.classList.remove('loading-phone', 'missing');
        clearInterval(intervalId);
        return;
      }

      if (data.status === 'unavailable') {
        valueEl.textContent = 'No disponible';
        valueEl.classList.remove('loading-phone');
        valueEl.classList.add('missing');
        clearInterval(intervalId);
        return;
      }
    } catch (err) {
      // Error de red puntual: seguimos intentando hasta agotar los intentos.
    }

    if (attempts >= PHONE_POLL_MAX_ATTEMPTS) {
      valueEl.textContent = 'No disponible';
      valueEl.classList.remove('loading-phone');
      valueEl.classList.add('missing');
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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const company = input.value.trim();
  if (!company) return;

  button.disabled = true;
  renderLoading();

  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company }),
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
