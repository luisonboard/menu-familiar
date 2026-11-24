-- =====================================================================
--  NÚCLEO MULTI-APP — un solo proyecto Supabase para todas mis apps
-- =====================================================================
--  Idea:
--    apps           catálogo de aplicaciones (menu-familiar, presupuesto, ...)
--    spaces         "espacio" de datos dentro de una app: Familia, Personal, etc.
--                   Se comparte con otras personas mediante un código.
--    space_members  quién pertenece a cada espacio y con qué rol
--    records        almacén genérico tipo documento (JSONB) por espacio:
--                   (space_id, collection, key) → data
--                   Sirve para cualquier app sin crear tablas nuevas.
--                   Tiene realtime y borrado lógico (deleted) para sincronizar.
--
--  Si una app necesita consultas SQL de verdad (sumas, filtros por fecha…),
--  se le crea su propio schema con tablas que referencian spaces(id) y reusan
--  public.is_space_member() en sus políticas. Ver plantilla_app_relacional.sql.
--
--  Ejecutar en: Supabase → SQL Editor → pegar y "Run". Es idempotente en lo posible.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------
create table if not exists public.apps (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name        text not null,
  created_at  timestamptz not null default now()
);
comment on table public.apps is 'Catálogo de aplicaciones que comparten este proyecto.';

create table if not exists public.spaces (
  id          uuid primary key default gen_random_uuid(),
  app_id      text not null references public.apps(id) on delete cascade,
  name        text not null default 'Mi espacio',
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  join_code   text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 8)),
  created_at  timestamptz not null default now()
);
create index if not exists spaces_app_idx   on public.spaces(app_id);
create index if not exists spaces_owner_idx on public.spaces(owner_id);
comment on table public.spaces is 'Contenedor de datos de una app (p. ej. "Familia" en menu-familiar). Se comparte por join_code.';

create table if not exists public.space_members (
  space_id    uuid not null references public.spaces(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'editor' check (role in ('owner','editor','viewer')),
  joined_at   timestamptz not null default now(),
  primary key (space_id, user_id)
);
create index if not exists space_members_user_idx on public.space_members(user_id);

create table if not exists public.records (
  id          uuid primary key default gen_random_uuid(),
  space_id    uuid not null references public.spaces(id) on delete cascade,
  app_id      text not null references public.apps(id) on delete cascade, -- lo llena el trigger
  collection  text not null check (length(collection) between 1 and 80),
  key         text not null check (length(key) between 1 and 300),
  data        jsonb not null default '{}'::jsonb,
  deleted     boolean not null default false,
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid() references auth.users(id) on delete set null,
  unique (space_id, collection, key)
);
create index if not exists records_space_coll_idx    on public.records(space_id, collection);
create index if not exists records_space_updated_idx on public.records(space_id, updated_at);
create index if not exists records_app_idx           on public.records(app_id);
comment on table public.records is 'Almacén documento genérico por app/espacio. Upsert por (space_id, collection, key).';

-- ---------------------------------------------------------------------
-- Funciones auxiliares
-- ---------------------------------------------------------------------
-- ¿El usuario actual pertenece al espacio? p_write=true exige rol owner/editor.
-- SECURITY DEFINER para evitar recursión de RLS sobre space_members.
create or replace function public.is_space_member(p_space uuid, p_write boolean default false)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.space_members m
    where m.space_id = p_space
      and m.user_id  = auth.uid()
      and (not p_write or m.role in ('owner','editor'))
  );
$$;

-- Al crear un espacio, su dueño queda como miembro 'owner'.
create or replace function public.tg_spaces_add_owner()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.space_members(space_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (space_id, user_id) do update set role = 'owner';
  return new;
end $$;

drop trigger if exists spaces_add_owner on public.spaces;
create trigger spaces_add_owner after insert on public.spaces
for each row execute function public.tg_spaces_add_owner();

-- records: app_id derivado del espacio, metadatos y llaves inmutables.
create or replace function public.tg_records_defaults()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    select s.app_id into new.app_id from public.spaces s where s.id = new.space_id;
    new.version    := 1;
    new.created_at := now();
  else
    new.space_id   := old.space_id;     -- no se puede mover un registro de espacio
    new.app_id     := old.app_id;
    new.collection := old.collection;
    new.key        := old.key;
    new.created_at := old.created_at;
    new.version    := old.version + 1;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;

drop trigger if exists records_defaults on public.records;
create trigger records_defaults before insert or update on public.records
for each row execute function public.tg_records_defaults();

-- ---------------------------------------------------------------------
-- RPCs (se llaman con supabase.rpc('nombre', {...}))
-- ---------------------------------------------------------------------
-- Devuelve el espacio del usuario para una app; si no tiene ninguno, lo crea.
create or replace function public.ensure_space(p_app text, p_name text default 'Mi espacio')
returns public.spaces
language plpgsql security definer set search_path = ''
as $$
declare s public.spaces;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from public.apps where id = p_app) then
    raise exception 'app_not_registered: %', p_app;
  end if;
  select sp.* into s
    from public.spaces sp
    join public.space_members m on m.space_id = sp.id and m.user_id = auth.uid()
   where sp.app_id = p_app
   order by (sp.owner_id = auth.uid()), m.joined_at   -- primero uno compartido conmigo (false < true)
   limit 1;
  if s.id is null then
    insert into public.spaces(app_id, name, owner_id) values (p_app, p_name, auth.uid())
    returning * into s;
  end if;
  return s;
end $$;

-- Unirse a un espacio con su código (p. ej. Paola se une a la "Familia" de Luis).
create or replace function public.join_space(p_code text)
returns public.spaces
language plpgsql security definer set search_path = ''
as $$
declare s public.spaces;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into s from public.spaces where join_code = upper(trim(p_code));
  if s.id is null then raise exception 'invalid_code'; end if;
  insert into public.space_members(space_id, user_id, role)
  values (s.id, auth.uid(), 'editor')
  on conflict (space_id, user_id) do nothing;
  return s;
end $$;

-- Cambiar el código (deja de servir el anterior). Solo el dueño.
create or replace function public.regenerate_join_code(p_space uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare c text := upper(substr(md5(gen_random_uuid()::text), 1, 8));
begin
  update public.spaces set join_code = c where id = p_space and owner_id = auth.uid();
  if not found then raise exception 'not_owner'; end if;
  return c;
end $$;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.apps          enable row level security;
alter table public.spaces        enable row level security;
alter table public.space_members enable row level security;
alter table public.records       enable row level security;

-- apps: lectura para usuarios logueados; se registran desde el SQL Editor.
drop policy if exists apps_read on public.apps;
create policy apps_read on public.apps for select to authenticated using (true);

-- spaces
drop policy if exists spaces_read   on public.spaces;
drop policy if exists spaces_insert on public.spaces;
drop policy if exists spaces_update on public.spaces;
drop policy if exists spaces_delete on public.spaces;
create policy spaces_read   on public.spaces for select to authenticated
  using (owner_id = (select auth.uid()) or public.is_space_member(id));
create policy spaces_insert on public.spaces for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy spaces_update on public.spaces for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy spaces_delete on public.spaces for delete to authenticated
  using (owner_id = (select auth.uid()));

-- space_members: ves a los miembros de tus espacios; sales tú o te saca el dueño.
-- (altas solo vía trigger del dueño o join_space)
drop policy if exists members_read   on public.space_members;
drop policy if exists members_delete on public.space_members;
drop policy if exists members_update on public.space_members;
create policy members_read on public.space_members for select to authenticated
  using (public.is_space_member(space_id));
create policy members_delete on public.space_members for delete to authenticated
  using (
    (user_id = (select auth.uid()) and role <> 'owner')
    or exists (select 1 from public.spaces s where s.id = space_id and s.owner_id = (select auth.uid()) and user_id <> s.owner_id)
  );
create policy members_update on public.space_members for update to authenticated
  using      (exists (select 1 from public.spaces s where s.id = space_id and s.owner_id = (select auth.uid()) and user_id <> s.owner_id))
  with check (role in ('editor','viewer'));

-- records: leen todos los miembros; escriben owner/editor.
drop policy if exists records_read   on public.records;
drop policy if exists records_insert on public.records;
drop policy if exists records_update on public.records;
drop policy if exists records_delete on public.records;
create policy records_read   on public.records for select to authenticated
  using (public.is_space_member(space_id));
create policy records_insert on public.records for insert to authenticated
  with check (public.is_space_member(space_id, true));
create policy records_update on public.records for update to authenticated
  using (public.is_space_member(space_id, true)) with check (public.is_space_member(space_id, true));
create policy records_delete on public.records for delete to authenticated
  using (public.is_space_member(space_id, true));

-- ---------------------------------------------------------------------
-- Permisos explícitos (obligatorios en proyectos nuevos de Supabase)
-- ---------------------------------------------------------------------
revoke all on public.apps, public.spaces, public.space_members, public.records from anon;
grant select                          on public.apps          to authenticated;
grant select, insert, update, delete  on public.spaces        to authenticated;
grant select, update, delete          on public.space_members to authenticated;
grant select, insert, update, delete  on public.records       to authenticated;

revoke all on function public.is_space_member(uuid, boolean)  from public, anon;
revoke all on function public.ensure_space(text, text)         from public, anon;
revoke all on function public.join_space(text)                 from public, anon;
revoke all on function public.regenerate_join_code(uuid)       from public, anon;
revoke all on function public.tg_spaces_add_owner()            from public, anon, authenticated;
grant execute on function public.is_space_member(uuid, boolean) to authenticated;
grant execute on function public.ensure_space(text, text)        to authenticated;
grant execute on function public.join_space(text)                to authenticated;
grant execute on function public.regenerate_join_code(uuid)      to authenticated;

-- ---------------------------------------------------------------------
-- Realtime: los cambios en records llegan al instante a los miembros
-- (Realtime respeta las políticas RLS de arriba).
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'records'
  ) then
    alter publication supabase_realtime add table public.records;
  end if;
end $$;
