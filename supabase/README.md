# Supabase multi-app — un proyecto para todas mis apps personales

El plan gratuito permite 2 proyectos activos, así que todas las apps personales comparten **un solo
proyecto** con este esquema. Cada app se registra en `apps` y guarda sus datos dentro de "espacios".

```
auth.users ──┐
             │ (owner)                        ┌──────────── records ─────────────┐
apps ──< spaces ──< space_members >── users   │ space_id, collection, key → data │
  │        │                                  │ jsonb · deleted · version · RT   │
  │        └──────────────────────────────────┴──────────────────────────────────┘
  │        └──< <schema_de_app>.<tabla>  (opcional, para apps relacionales)
```

| Tabla | Para qué |
|---|---|
| `apps` | Catálogo: `menu-familiar`, `presupuesto`, `carrera-del-tiempo`… |
| `spaces` | Contenedor de datos de una app: "Familia", "Personal"… Tiene `join_code` para compartir. |
| `space_members` | Quién entra a cada espacio: `owner`, `editor`, `viewer`. |
| `records` | Almacén genérico por documento: `(space_id, collection, key) → data jsonb`. Tiene realtime y borrado lógico. |

**Seguridad (RLS):** cada usuario solo ve los espacios de los que es miembro. Los `viewer` solo leen,
`owner`/`editor` escriben. El rol `anon` no tiene acceso a nada. Todo está probado con Postgres 16:
un extraño no ve ni modifica nada, Paola entra con el código y edita, nadie puede mover un registro
a otro espacio y solo el dueño cambia el código.

## Instalación

1. Supabase → **SQL Editor** → ejecuta en orden:
   1. `001_nucleo_multiapp.sql` (núcleo, se puede volver a ejecutar sin problema)
   2. `002_app_menu_familiar.sql` (registra la app)
2. **Authentication → Sign In / Providers**:
   - **Email**: activo (viene por defecto).
   - ⚠️ Sin SMTP propio, Supabase **solo envía correos a los miembros del equipo de la organización**
     (máx. 2/hora) y no deja editar las plantillas: el correo trae un enlace (no código).
     Para que otras personas entren por correo, configura un SMTP (Resend, Brevo…) en
     **Authentication → Emails → SMTP Settings**, o usa Google.
   - **Google** (opcional): pega Client ID + Secret de un cliente OAuth "Aplicación web" de Google Cloud,
     cuya *URI de redirección autorizada* sea `https://<tu-ref>.supabase.co/auth/v1/callback`.
3. **Authentication → URL Configuration**:
   - *Site URL*: `https://menu-familiar.pages.dev`
   - *Redirect URLs*: agrega la URL de cada app (`https://menu-familiar.pages.dev/**`,
     `https://<otra-app>.pages.dev/**`, `http://localhost:8080/**`).
4. **Project Settings → API Keys** → copia *Project URL* y *Publishable key* al `config.js` de cada app.

## Agregar una app nueva

**Si basta con documentos JSON** (lo más común en apps personales):
```sql
insert into public.apps(id, name) values ('mi-app', 'Mi app');
```
En el cliente:
```js
const { data: space } = await sb.rpc('ensure_space', { p_app: 'mi-app', p_name: 'Personal' });
await sb.from('records').upsert(
  [{ space_id: space.id, collection: 'tareas', key: 't1', data: { titulo: 'Comprar pan' } }],
  { onConflict: 'space_id,collection,key' }
);
sb.channel('x').on('postgres_changes',
  { event: '*', schema: 'public', table: 'records', filter: `space_id=eq.${space.id}` },
  p => console.log(p.new)).subscribe();
```
Para borrar, usa `deleted: true` (borrado lógico) para que los demás dispositivos se enteren.

**Si necesitas SQL de verdad** (sumas, filtros por fecha…): usa `plantilla_app_relacional.sql`.
Esa plantilla crea un schema por app con tablas que referencian `spaces(id)` y reusan
`public.is_space_member()`. Después agrega el schema en **Settings → Data API → Exposed schemas**.

## RPCs disponibles

| Función | Uso |
|---|---|
| `ensure_space(p_app, p_name)` | Devuelve el espacio del usuario para esa app (prefiere uno compartido) o lo crea. |
| `join_space(p_code)` | Unirse a un espacio con su código (rol editor). |
| `regenerate_join_code(p_space)` | Solo el dueño: invalida el código anterior. |
| `is_space_member(p_space, p_write)` | Para usar en las políticas RLS de las tablas propias de cada app. |

## Ten en cuenta (plan gratuito)

- Si el proyecto pasa **7 días sin actividad**, Supabase lo pausa. Se reactiva desde el dashboard
  y no pierdes los datos. Con varias apps compartiendo el proyecto es más difícil que quede inactivo.
- El plan gratuito **no incluye backups**: de vez en cuando usa "Exportar archivo" en cada app o
  `supabase db dump`.
