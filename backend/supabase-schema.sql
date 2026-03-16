create extension if not exists "pgcrypto";

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_name text not null,
  device_token text not null unique,
  status text not null default 'offline' check (status in ('online', 'offline')),
  created_at timestamptz not null default now()
);

create index if not exists devices_user_id_idx on public.devices(user_id);

alter table public.devices enable row level security;

create policy "Users can view their own devices"
on public.devices
for select
using (auth.uid() = user_id);

create policy "Users can insert their own devices"
on public.devices
for insert
with check (auth.uid() = user_id);

create policy "Users can update their own devices"
on public.devices
for update
using (auth.uid() = user_id);
