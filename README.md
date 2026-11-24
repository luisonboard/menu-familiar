# Menú de la semana — PWA

App estática (HTML + JS, sin build), instalable, que funciona offline y se sincroniza en tiempo real
con Supabase (proyecto multi-app compartido, ver `supabase/`).

```
index.html          app completa (menú + lista de compras)
config.js           ← SUPABASE_URL y SUPABASE_KEY (publishable)
cloud-sync.js       login, espacio familiar, sincronización local-first + realtime
vendor/supabase.js  supabase-js 2.119.2 (UMD, incluido para que funcione offline)
sw.js               service worker (offline + aviso "Hay una nueva versión")
manifest.json       manifest PWA
_headers            cabeceras para Cloudflare Pages
icons/
supabase/           esquema multi-app compartido (SQL + guía)
```

## 1. Configurar Supabase

Sigue `supabase/README.md` (ejecutar SQL, correo con código, URLs permitidas)
y luego completa `config.js`:
```js
SUPABASE_URL: 'https://<tu-ref>.supabase.co',
SUPABASE_KEY: 'sb_publishable_...',
LOGIN_METHODS: ['email', 'google']   // quita 'google' si no configuras ese proveedor
```

### Cómo se usa
- **Entrar** con tu correo (te llega un código) o con Google.
- La primera vez se crea el espacio **"Familia"**. Si en la nube ya hay datos, la app pregunta cuál conservar.
- **Invitar** comparte el código; Paola entra con su cuenta, toca **Unirme con código** y desde ahí
  ven y editan el mismo menú y la misma lista **en tiempo real** (ej. marcar cosas en el súper).
- Sin internet todo sigue funcionando; al volver se sincroniza solo.
- **Exportar / Importar archivo** queda como respaldo manual en `.json`.

## 2. Publicar en Cloudflare Pages

**Opción A — conectado al repo de GitHub:**
Repo: https://github.com/luisonboard/menu-familiar
Cloudflare → **Workers & Pages → Crear → Pages → Conectar a Git** → elige el repo.
Framework: *Ninguno* · Comando de build: *(vacío)* · Directorio de salida: `/`.
Cada `git push` vuelve a desplegar.

**Opción B — subida directa sin repo:**
```bash
npx wrangler login
npx wrangler pages deploy . --project-name=menu-familiar
```

## 3. Publicar una versión nueva

1. Haz los cambios.
2. Sube `CACHE_VERSION` en `sw.js` (`v7` → `v8`).
3. Push / deploy. Al abrir la app aparece **"✨ Hay una nueva versión — Actualizar"**.

## Probar en local

```bash
python3 -m http.server 8080
# abre http://localhost:8080
```
