# Buscador de contacto ideal (Apollo.io)

App web sencilla: ingresas el nombre de una empresa y el backend consulta la API
de [Apollo.io](https://apollo.io) para devolver el mejor contacto para llamar,
priorizando cargos de **ventas, trade marketing, mercadeo, marketing o category
manager** (nombre, cargo, teléfono y/o email).

## Cómo funciona

1. El frontend (`public/`) envía el nombre de la empresa a `POST /api/search`.
2. El backend (`server.js`) busca la organización en Apollo (`/organizations/search`).
3. Busca personas de esa organización cuyo cargo coincida con ventas, trade
   marketing, mercadeo, marketing o category manager (`/mixed_people/api_search`).
4. Ordena los resultados por relevancia de cargo y seniority (director/gerente/etc.)
   y enriquece al mejor candidato (`/people/match`) para revelar email y teléfono.
5. Devuelve nombre, cargo, teléfono y email al frontend.

La API key de Apollo **nunca se expone al navegador**: solo vive en el backend,
leída desde la variable de entorno `APOLLO_API_KEY`.

## Configuración local

1. Instala dependencias:

   ```bash
   npm install
   ```

2. Copia el archivo de ejemplo y coloca tu API key real de Apollo:

   ```bash
   cp .env.example .env
   ```

   Edita `.env` y reemplaza el valor:

   ```
   APOLLO_API_KEY=tu_api_key_real
   ```

   Obtén tu API key en Apollo: **Settings → Integrations → API** dentro de tu
   cuenta de Apollo.io. El archivo `.env` está en `.gitignore`, así que nunca se
   sube al repositorio.

3. Inicia el servidor:

   ```bash
   npm start
   ```

4. Abre [http://localhost:3000](http://localhost:3000).

## Despliegue en producción

No subas nunca la API key al código ni al repositorio. En su lugar, configúrala
como variable de entorno en la plataforma donde despliegues (Render, Railway,
Fly.io, Heroku, etc.), normalmente en una sección "Environment Variables" del
panel del servicio, con la clave `APOLLO_API_KEY`.

## Notas sobre la API de Apollo

- Las búsquedas y el enriquecimiento de contactos (`/people/match` con
  `reveal_personal_emails` y `reveal_phone_number`) consumen créditos de tu
  plan de Apollo.
- No todos los contactos tienen teléfono o email disponibles en la base de
  Apollo; en ese caso la app muestra "No disponible" en ese campo.
- Los cargos objetivo se buscan en español e inglés (`ventas`, `sales`,
  `marketing`, `mercadeo`, `trade marketing`, `category manager`) y Apollo
  hace un match flexible sobre el título del contacto.

## Depurar respuestas de Apollo

Si el nombre, teléfono o email salen como "No disponible", pon
`APOLLO_DEBUG=true` en tu `.env` (o como variable de entorno en producción)
y reinicia el servidor. Cada búsqueda imprimirá en los logs del servidor la
respuesta cruda de `/mixed_people/api_search` y de `/people/match`, para ver
si Apollo está devolviendo los datos vacíos, enmascarados (por ejemplo
`email_not_unlocked@domain.com`) o si la llamada de enriquecimiento está
fallando. Vuelve a poner `APOLLO_DEBUG=false` cuando termines, ya que estos
logs pueden incluir datos personales de los contactos.
