-- =====================================================================
--  PLANTILLA: app con tablas propias (cuando JSON en records no basta)
--  Ejemplo: presupuesto con gastos que quieres sumar por fecha/categoría.
--  Copia, renombra "presupuesto" y ajusta columnas.
-- =====================================================================
insert into public.apps(id, name) values ('presupuesto', 'Presupuesto diario')
on conflict (id) do nothing;

-- Un schema por app mantiene todo ordenado en un solo proyecto.
-- IMPORTANTE: luego en Supabase → Settings → Data API → "Exposed schemas" agrega "presupuesto".
-- En el cliente: supabase.schema('presupuesto').from('gastos')...
create schema if not exists presupuesto;
grant usage on schema presupuesto to authenticated;

create table if not exists presupuesto.gastos (
  id          uuid primary key default gen_random_uuid(),
  space_id    uuid not null references public.spaces(id) on delete cascade,
  fecha       date not null default current_date,
  monto       numeric(12,2) not null check (monto >= 0),
  categoria   text,
  nota        text,
  created_by  uuid default auth.uid() references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists gastos_space_fecha_idx on presupuesto.gastos(space_id, fecha);

alter table presupuesto.gastos enable row level security;
drop policy if exists gastos_read  on presupuesto.gastos;
drop policy if exists gastos_write on presupuesto.gastos;
create policy gastos_read  on presupuesto.gastos for select to authenticated
  using (public.is_space_member(space_id));
create policy gastos_write on presupuesto.gastos for all to authenticated
  using (public.is_space_member(space_id, true)) with check (public.is_space_member(space_id, true));

grant select, insert, update, delete on presupuesto.gastos to authenticated;

-- Opcional: realtime también para esta tabla
-- alter publication supabase_realtime add table presupuesto.gastos;
