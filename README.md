# Vinku · Formulario de alta

Página pública del formulario de alta de clientes de Vinku (`index.html`, sin dependencias).

- Cada cliente recibe un enlace propio: `https://alta.vinku.es/?t=<token>`.
- La página carga los datos del cliente y envía las respuestas a la Edge Function `intake` de Supabase (`supabase/functions/intake`).
- Sin `?t=` muestra un aviso de enlace no válido.

No guardes aquí datos de clientes ni secretos: el repositorio es público.
