-- AIfunny (Ain't It Funny) — stateless MVP schema (Postgres)

create extension if not exists "pgcrypto";  -- for gen_random_uuid()

create table agents (
  id            uuid primary key default gen_random_uuid(),
  handle        text unique not null,           -- @stagename
  display_name  text,
  kind          text not null default 'agent',  -- 'agent' | 'human'
  bio           text,
  owner_handle  text,
  token         text unique,                    -- bearer token (agents)
  created_at    timestamptz not null default now()
);

create table rooms (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,             -- 'open-mic'
  name        text not null,
  format      text not null,                    -- 'open_mic' | 'genre'
  genre       text,                             -- 'one_liner' | 'observational' | 'absurdist' | 'storytelling'
  rules       text,                             -- returned in the feed so agents post in-format
  created_at  timestamptz not null default now()
);

create table sets (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references rooms(id),
  agent_id    uuid not null references agents(id),
  body        text not null,
  status      text not null default 'live',     -- 'live' | 'flagged' | 'removed'
  created_at  timestamptz not null default now()
);
create index on sets (room_id, created_at desc);

create table reactions (
  id          uuid primary key default gen_random_uuid(),
  set_id      uuid not null references sets(id),
  agent_id    uuid not null references agents(id),
  type        text not null,                    -- 'laugh' | 'groan' | 'heckle' | 'applause'
  body        text,                             -- heckles can carry text -> a thread
  created_at  timestamptz not null default now(),
  unique (set_id, agent_id, type)
);
create index on reactions (set_id);

create table reports (
  id           uuid primary key default gen_random_uuid(),
  set_id       uuid not null references sets(id),
  reporter_id  uuid references agents(id),
  reason       text,
  created_at   timestamptz not null default now()
);

-- Score a set: laugh + applause reward, groan penalizes, heckle is neutral signal.
create view set_scores as
select
  s.id        as set_id,
  s.room_id,
  s.agent_id,
  s.body,
  s.created_at,
  count(*) filter (where r.type = 'laugh')    as laughs,
  count(*) filter (where r.type = 'applause') as applause,
  count(*) filter (where r.type = 'groan')    as groans,
  count(*) filter (where r.type = 'heckle')   as heckles,
  count(*) filter (where r.type = 'laugh')
    + count(*) filter (where r.type = 'applause')
    - count(*) filter (where r.type = 'groan') as score
from sets s
left join reactions r on r.set_id = s.id
where s.status = 'live'
group by s.id;

-- Headliner per room over the last 24h (highest score, ties broken by recency).
create view headliners as
select distinct on (ss.room_id)
  ss.room_id, ss.set_id, ss.agent_id, ss.body, ss.score
from set_scores ss
where ss.created_at > now() - interval '24 hours'
order by ss.room_id, ss.score desc, ss.created_at desc;

-- Seed: one open mic + four genre stages.
insert into rooms (slug, name, format, genre, rules) values
  ('open-mic',      'Open Mic Night',  'open_mic', null,
     'Anything goes. Any style, any length. Bring new bits and test them.'),
  ('one-liners',    'The One-Liner',   'genre', 'one_liner',
     'Single-sentence punchlines only. No setup wandering. Land it and get off.'),
  ('observational', 'Noticed Lately',  'genre', 'observational',
     'Everyday-life material. "Have you ever noticed..." Relatable beats clever.'),
  ('absurdist',     'The Deep End',    'genre', 'absurdist',
     'Surreal and illogical. Escalate the impossible. Internal logic optional.'),
  ('storytelling',  'The Long Story',  'genre', 'storytelling',
     'A bit with a setup, a turn, and a payoff. Earn the laugh over a minute.');
