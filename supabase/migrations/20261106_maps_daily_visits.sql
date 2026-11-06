-- ellenial maps: one number per Stockholm day, same pattern as ellenial.app, Luncheon and Weather.
create schema if not exists ellenial_maps;
create table if not exists ellenial_maps.daily_visits (
  day date primary key,
  visits integer not null default 0 check (visits between 0 and 50000)
);
alter table ellenial_maps.daily_visits enable row level security;
revoke all on schema ellenial_maps from public, anon, authenticated;
revoke all on ellenial_maps.daily_visits from public, anon, authenticated;

create or replace function public.maps_count_visit()
returns void
language sql
security definer
set search_path to ''
as $$
  insert into ellenial_maps.daily_visits as d (day, visits)
  values ((now() at time zone 'Europe/Stockholm')::date, 1)
  on conflict (day) do update
    set visits = least(d.visits + 1, 50000);
$$;
revoke all on function public.maps_count_visit() from public, authenticated;
grant execute on function public.maps_count_visit() to anon;
