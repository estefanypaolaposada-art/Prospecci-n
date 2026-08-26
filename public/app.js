const form = document.getElementById('search-form');
const input = document.getElementById('company-input');
const button = document.getElementById('search-button');
const resultArea = document.getElementById('result-area');

function renderLoading() {
  resultArea.innerHTML = '<p class="loading">Buscando en Apollo.io...</p>';
}

function renderError(message) {
  resultArea.innerHTML = `<div class="error-box">${escapeHtml(message)}</div>`;
}

function renderResult(data) {
  const { organization, contact } = data;

  const field = (label, value) =>
    `<div class="contact-field">
       <span class="label">${label}</span>
       <span class="value ${value ? '' : 'missing'}">${value ? escapeHtml(value) : 'No disponible'}</span>
     </div>`;

  resultArea.innerHTML = `
    <div class="card">
      <div class="org-name">${escapeHtml(organization.name)}</div>
      ${organization.website_url ? `<span class="org-website">${escapeHtml(organization.website_url)}</span>` : ''}
      ${field('Nombre', contact.name)}
      ${field('Cargo', contact.title)}
      ${field('Teléfono', contact.phone)}
      ${field('Email', contact.email)}
      ${contact.linkedin_url ? field('LinkedIn', contact.linkedin_url) : ''}
    </div>
  `;
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
