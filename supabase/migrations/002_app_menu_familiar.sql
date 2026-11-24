-- Registrar la app Menú Familiar. Cada app nueva = una línea aquí.
insert into public.apps(id, name) values ('menu-familiar', 'Menú de la semana')
on conflict (id) do update set name = excluded.name;

-- Colecciones que usa menu-familiar en public.records:
--   menu-day        key = lunes..domingo      data = { label, note, desayuno:{name,ingredients,notes}, ... }
--   shopping-check  key = "nombre|unidad" o "extra:<id>"   data = { checked: true|false }
--   shopping-extra  key = <id>                data = { id, name, qty, unit }
-- Un registro por día / por artículo: si Luis y Paola editan cosas distintas
-- al mismo tiempo no se pisan.
