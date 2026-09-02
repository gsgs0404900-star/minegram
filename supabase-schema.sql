-- Minegram / Supabase setup
-- Run this whole file in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete cascade,
  username text not null unique check (username = lower(username)),
  display_name text not null default '',
  bio text not null default '',
  avatar_url text,
  verified boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  caption text not null default '',
  media_url text,
  media_name text,
  media_type text,
  created_at timestamptz not null default now()
);

create table if not exists public.post_likes (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  text text not null check (char_length(trim(text)) > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.saves (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  from_user_id uuid references public.profiles(id) on delete set null,
  post_id uuid references public.posts(id) on delete cascade,
  text text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  text text not null check (char_length(trim(text)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists posts_created_at_idx on public.posts(created_at desc);
create index if not exists posts_user_id_idx on public.posts(user_id);
create index if not exists comments_post_id_idx on public.comments(post_id);
create index if not exists comments_user_id_idx on public.comments(user_id);
create index if not exists notifications_user_id_idx on public.notifications(user_id, created_at desc);
create index if not exists messages_pair_idx on public.messages(sender_id, recipient_id, created_at);
create index if not exists follows_following_idx on public.follows(following_id);

-- Compatibility column for the Minegram backend.
alter table public.profiles
  add column if not exists auth_user_id uuid references auth.users(id) on delete cascade;

-- Existing profiles are their own Auth users.
update public.profiles
set auth_user_id = id
where auth_user_id is null;

-- Create a profile automatically when Supabase Auth creates a user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_username text;
  requested_display text;
begin
  requested_username := lower(regexp_replace(coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)), '[^a-zA-Z0-9_\.]+', '', 'g'));
  if requested_username = '' then requested_username := 'user'; end if;
  requested_display := coalesce(new.raw_user_meta_data->>'display_name', requested_username);

  if exists (select 1 from public.profiles where username = requested_username) then
    requested_username := requested_username || '_' || substr(replace(new.id::text, '-', ''), 1, 6);
  end if;

  insert into public.profiles (id, auth_user_id, username, display_name)
  values (new.id, new.id, requested_username, requested_display)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.post_likes enable row level security;
alter table public.comments enable row level security;
alter table public.saves enable row level security;
alter table public.follows enable row level security;
alter table public.notifications enable row level security;
alter table public.messages enable row level security;

-- Profiles: public to read; users edit only their own.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (true);
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- Posts: public read; authenticated users create their own and delete/update their own.
drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts for select using (true);
drop policy if exists posts_insert on public.posts;
create policy posts_insert on public.posts for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists posts_update on public.posts;
create policy posts_update on public.posts for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists posts_delete on public.posts;
create policy posts_delete on public.posts for delete to authenticated using ((select auth.uid()) = user_id);

-- Likes / comments / saves are public to read; authenticated users own their rows.
drop policy if exists likes_select on public.post_likes;
create policy likes_select on public.post_likes for select using (true);
drop policy if exists likes_insert on public.post_likes;
create policy likes_insert on public.post_likes for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists likes_delete on public.post_likes;
create policy likes_delete on public.post_likes for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments for select using (true);
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists saves_select on public.saves;
create policy saves_select on public.saves for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists saves_insert on public.saves;
create policy saves_insert on public.saves for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists saves_delete on public.saves;
create policy saves_delete on public.saves for delete to authenticated using ((select auth.uid()) = user_id);

-- Follows: public read; authenticated user owns follower_id.
drop policy if exists follows_select on public.follows;
create policy follows_select on public.follows for select using (true);
drop policy if exists follows_insert on public.follows;
create policy follows_insert on public.follows for insert to authenticated with check ((select auth.uid()) = follower_id);
drop policy if exists follows_delete on public.follows;
create policy follows_delete on public.follows for delete to authenticated using ((select auth.uid()) = follower_id);

-- Notifications: recipient only.
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
-- Messages: participants only.
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated using ((select auth.uid()) = sender_id or (select auth.uid()) = recipient_id);
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated with check ((select auth.uid()) = sender_id);

-- Storage bucket for public social-media files.
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do update set public = true;

drop policy if exists media_public_read on storage.objects;
create policy media_public_read on storage.objects for select using (bucket_id = 'media');
drop policy if exists media_authenticated_insert on storage.objects;
create policy media_authenticated_insert on storage.objects for insert to authenticated with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists media_owner_update on storage.objects;
create policy media_owner_update on storage.objects for update to authenticated using (bucket_id = 'media' and owner_id = (select auth.uid())::text);
drop policy if exists media_owner_delete on storage.objects;
create policy media_owner_delete on storage.objects for delete to authenticated using (bucket_id = 'media' and owner_id = (select auth.uid())::text);

-- Data API permissions (least privilege for the browser/server publishable key).
grant select on public.profiles, public.posts, public.post_likes, public.comments, public.follows to anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant insert, update, delete on public.posts to authenticated;
grant insert, delete on public.post_likes to authenticated;
grant insert, update, delete on public.comments to authenticated;
grant select, insert, delete on public.saves to authenticated;
grant insert, delete on public.follows to authenticated;
grant select, update on public.notifications to authenticated;
grant select, insert on public.messages to authenticated;
