-- Шема за Postgres, односно за Supabase.
--
-- Апликација ово покреће сама при подизању, па ручни упис није неопходан.
-- Фајл постоји да би шема била видљива и да би могла да се примени унапред,
-- кроз SQL Editor у Supabase-у.
--
-- База мора да буде UTF8. Цео садржај је на ћирилици, а база у другом
-- кодирању одбија упис уз поруку о знаку без еквивалента.

CREATE TABLE IF NOT EXISTS sources (
  id          bigserial PRIMARY KEY,
  url         text NOT NULL,
  sha256      text NOT NULL UNIQUE,
  bytes       bigint NOT NULL,
  period_from date,
  period_to   date,
  allergens   text,
  note        text,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  day_count   integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS days (
  date       date PRIMARY KEY,
  weekday    text NOT NULL,
  source_id  bigint NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id    bigserial PRIMARY KEY,
  date  date NOT NULL REFERENCES days(date) ON DELETE CASCADE,
  meal  text NOT NULL,
  ord   integer NOT NULL,
  label text NOT NULL
);
CREATE INDEX IF NOT EXISTS items_by_day ON items(date, meal, ord);

CREATE TABLE IF NOT EXISTS subscriptions (
  id           bigserial PRIMARY KEY,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  dorucak      boolean NOT NULL DEFAULT true,
  rucak        boolean NOT NULL DEFAULT true,
  vecera       boolean NOT NULL DEFAULT true,
  failures     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sent_log (
  id      bigserial PRIMARY KEY,
  meal    text NOT NULL,
  date    date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  total   integer NOT NULL,
  failed  integer NOT NULL,
  UNIQUE (meal, date)
);

-- Supabase уз сваку базу нуди и јавни REST приступ преко анонимног кључа.
-- Без овога би свако са тим кључем могао да чита претплате корисника.
-- Заштита се укључује без иједног правила, чиме тај пут остаје затворен,
-- док апликација наставља да ради јер се повезује као власник таблица.
ALTER TABLE sources       ENABLE ROW LEVEL SECURITY;
ALTER TABLE days          ENABLE ROW LEVEL SECURITY;
ALTER TABLE items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sent_log      ENABLE ROW LEVEL SECURITY;
