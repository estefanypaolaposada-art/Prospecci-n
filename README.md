# Buscador de contacto ideal (Apollo.io)

App web sencilla: ingresas el nombre de una empresa y el backend consulta la API
de [Apollo.io](https://apollo.io) para devolver los mejores contactos para llamar,
priorizando cargos de **ventas, trade marketing, mercadeo, marketing o category
manager** (nombre completo, cargo, teléfono y/o email).

## Cómo funciona

1. El frontend (`public/`) envía el nombre de la empresa a `POST /api/search`.
2. El backend (`server.js`) busca la organización en Apollo (`/organizations/search`).
3. Busca personas de esa organización cuyo cargo coincida con ventas, trade
   marketing, mercadeo, marketing o category manager (`/mixed_people/api_search`).
4. Ordena los resultados por relevancia de cargo y seniority (director/gerente/etc.)
   y toma hasta `MAX_RESULTS` candidatos (8 por defecto, configurable en
   `server.js`).
5. Enriquece cada uno de esos candidatos (`/people/match`) para revelar email y
   teléfono, y devuelve la lista completa al frontend, ordenada del contacto
   más relevante al menos relevante.

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
Fly.io, Heroku, Vercel, etc.), normalmente en una sección "Environment
Variables" del panel del servicio, con la clave `APOLLO_API_KEY`.

### Despliegue en Vercel

Este repo incluye `vercel.json` para que Vercel ejecute `server.js` como
función serverless (Express exportado con `module.exports = app`) y le pase
todas las rutas, incluyendo los archivos estáticos de `public/`.

**Importante sobre Vercel y estado en memoria:** Vercel ejecuta el backend
como funciones serverless — cada request puede caer en una instancia distinta
del servidor, sin memoria compartida entre ellas. Por eso el `Map` en memoria
que usa la app para el teléfono (`phoneRequests`) NO es confiable como única
fuente de verdad ahí: se usa solo como atajo cuando por casualidad una
petición cae en la misma instancia; la fuente real es que `GET
/api/phone/:personId` vuelve a preguntarle directamente a Apollo en cada
consulta si el teléfono ya está disponible (ver más abajo). Si en el futuro
quieres evitar esas consultas repetidas a Apollo, la solución correcta sería
usar un almacenamiento compartido de verdad (por ejemplo Vercel KV / Upstash
Redis) en vez del `Map`.

**Para confirmar que un deploy en Vercel sí tiene el último código:** abre
`https://tu-dominio.vercel.app/api/version` — devuelve el commit de Git que
está corriendo (`VERCEL_GIT_COMMIT_SHA`, que Vercel llena automáticamente).
Compáralo con el último commit de la rama `main` en GitHub; si no coincide,
el deploy no se actualizó (entra al dashboard de Vercel → pestaña
Deployments y fuerza un redeploy del último commit, o revisa si el proyecto
tiene el auto-deploy desde GitHub habilitado).

## Notas sobre la API de Apollo

- Las búsquedas y el enriquecimiento de contactos (`/people/match` con
  `reveal_personal_emails` y `reveal_phone_number`) consumen créditos de tu
  plan de Apollo. **Cada búsqueda ahora enriquece hasta `MAX_RESULTS`
  contactos (8 por defecto)**, así que consume más créditos que antes (cuando
  solo se enriquecía uno). Baja esa constante en `server.js` si quieres
  ahorrar créditos.
- No todos los contactos tienen teléfono, email o apellido disponibles en la
  base de Apollo; en ese caso la app muestra "No disponible" en ese campo.
- Los cargos objetivo se buscan en español e inglés (`ventas`, `sales`,
  `marketing`, `mercadeo`, `trade marketing`, `category manager`) y Apollo
  hace un match flexible sobre el título del contacto.
- **`/people/match` recibe sus parámetros por la URL (query string), no por
  el body.** Apollo lo documenta así (ver su ejemplo de `curl`); si se envían
  por el body, Apollo puede no interpretarlos correctamente. Este es el fix
  aplicado para que `reveal_personal_emails` y `reveal_phone_number` sí
  surtan efecto.
- **El teléfono se revela de forma asíncrona, y la app ya lo maneja
  automáticamente sin depender de memoria compartida entre requests**
  (importante en hosting serverless como Vercel, ver arriba). Apollo exige un
  `webhook_url` público para `reveal_phone_number=true`, y normalmente
  entrega el teléfono en una llamada aparte a ese webhook, no en la respuesta
  del `POST /api/search`. El flujo completo es:
  1. `POST /api/search` responde de inmediato con lo que ya tiene (nombre,
     cargo, email) y dispara la revelación del teléfono en Apollo. Si el
     teléfono aún no llegó, cada contacto trae `phoneStatus: "pending"` y el
     frontend muestra "Cargando teléfono..." con una animación.
  2. El navegador consulta `GET /api/phone/:personId` cada 4 segundos, hasta
     por 3 minutos, para cada contacto pendiente. Mientras espera, la
     tarjeta muestra una nota ("Apollo puede tardar hasta 3 min en
     confirmarlo") para que quede claro que sigue trabajando y no que se
     colgó.
  3. Esa consulta hace dos cosas: mira si por casualidad el webhook ya
     actualizó el `Map` en memoria de esta misma instancia del servidor, y
     además **vuelve a preguntarle directamente a Apollo** (`/people/match`
     solo con el `id`, sin volver a pedir revelación) si el teléfono ya está
     visible. En cuanto cualquiera de las dos vías lo confirma, la tarjeta se
     actualiza sola (número o "No disponible"), sin recargar la página.
  4. Si pasan los 3 minutos sin recibir un número, la tarjeta cambia a "No
     disponible".
  Ten en cuenta que, al reconsultar Apollo cada 4 segundos por hasta 3
  minutos y por cada contacto pendiente, una búsqueda con varios contactos
  sin teléfono inmediato puede generar bastantes llamadas a la API de
  Apollo; si tu plan tiene límite de requests por minuto, considera subir
  `PHONE_POLL_INTERVAL_MS` en `public/app.js`.
  Para confirmar que todo está funcionando, el servidor imprime **siempre**
  (sin necesidad de `APOLLO_DEBUG`) líneas de log sin datos personales:
  cuántos `phone_numbers` trae la respuesta síncrona de `/people/match` al
  pedir la revelación, cuántos trae cada reconsulta de `/api/phone/:id`, y
  cuántos contactos llegan en cada llamada a `/api/apollo-webhook`.

## Depurar respuestas de Apollo

Si el nombre, teléfono o email salen como "No disponible", pon
`APOLLO_DEBUG=true` en tu `.env` (o como variable de entorno en producción)
y reinicia el servidor. Cada búsqueda imprimirá en los logs del servidor la
respuesta cruda de `/mixed_people/api_search` y de `/people/match`, para ver
si Apollo está devolviendo los datos vacíos, enmascarados (por ejemplo
`email_not_unlocked@domain.com`) o si la llamada de enriquecimiento está
fallando. Vuelve a poner `APOLLO_DEBUG=false` cuando termines, ya que estos
logs pueden incluir datos personales de los contactos.
