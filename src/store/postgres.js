// Складиште на Postgres-у, за Supabase и сваки други Postgres.
// Исти облик функција као у складишту на SQLite-у, па остатак система
// не зна коју базу користи.

import pg from 'pg';
import { config } from '../config.js';

// Postgres тип DATE стиже као JS датум, што помера дан у другој временској
// зони. Тражимо чист низ "YYYY-MM-DD", какав систем свуда и користи.
pg.types.setTypeParser(1082, (value) => value);

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Supabase и већина хостованих база траже TLS, али са сертификатом
  // који локални коренски списак не познаје.
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: 4,
});

const query = (text, params) => pool.query(text, params);
const one = async (text, params) => (await query(text, params)).rows[0] ?? null;

export const kind = 'postgres';

export async function close() {
  await pool.end();
}

/** Прави таблице ако их нема. Иста шема стоји и у db/schema.sql. */
export async function migrate() {
  // Цео садржај је на ћирилици. База која није UTF8 одбија упис уз поруку
  // о знаку без еквивалента, што је лакше разумети овде него у сред обраде.
  const { rows } = await query('SHOW server_encoding');
  const encoding = rows[0].server_encoding;
  if (encoding.toUpperCase() !== 'UTF8') {
    throw new Error(
      `База користи кодирање ${encoding}, а потребан је UTF8, иначе ћирилица не може да се упише. `
      + 'Направи базу са: CREATE DATABASE ime WITH ENCODING \'UTF8\' TEMPLATE template0;',
    );
  }

  await query(`
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
  `);

  await lockDown();
}

/**
 * Затвара таблице за јавни приступ.
 *
 * Supabase уз сваку базу нуди и јавни REST приступ преко анонимног кључа.
 * Таблице направљене овако, из SQL-а, подразумевано немају укључену
 * заштиту редова, што значи да би свако са тим кључем могао да чита
 * претплате корисника. Укључујемо заштиту без иједног правила, чиме тај
 * пут остаје затворен, док апликација наставља да ради јер се повезује
 * као власник таблица.
 */
async function lockDown() {
  const tables = ['sources', 'days', 'items', 'subscriptions', 'sent_log'];
  for (const table of tables) {
    await query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  }
}

/* ---------- Извори ---------- */

export async function findSourceByHash(sha256) {
  return one('SELECT * FROM sources WHERE sha256 = $1', [sha256]);
}

export async function insertSource(source) {
  const row = await one(
    `INSERT INTO sources (url, sha256, bytes, period_from, period_to, allergens, note, day_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [source.url, source.sha256, source.bytes, source.periodFrom, source.periodTo,
      source.allergens, source.note, source.dayCount],
  );
  return Number(row.id);
}

export async function latestSource() {
  return one('SELECT * FROM sources ORDER BY id DESC LIMIT 1');
}

/* ---------- Дани и ставке ---------- */

export async function upsertDay(sourceId, day) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM items WHERE date = $1', [day.date]);
    await client.query(
      `INSERT INTO days (date, weekday, source_id, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (date) DO UPDATE SET weekday = excluded.weekday,
                                        source_id = excluded.source_id,
                                        updated_at = excluded.updated_at`,
      [day.date, day.weekday, sourceId],
    );

    // Све ставке једног дана иду једним упитом, јер је свака мрежна тура
    // ка хостованој бази скупља од самог уписа.
    const values = [];
    const params = [];
    for (const meal of ['dorucak', 'rucak', 'vecera']) {
      (day[meal] || []).forEach((label, index) => {
        params.push(day.date, meal, index, label);
        values.push(`($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length})`);
      });
    }
    if (values.length > 0) {
      await client.query(`INSERT INTO items (date, meal, ord, label) VALUES ${values.join(', ')}`, params);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getDay(date) {
  const day = await one('SELECT * FROM days WHERE date = $1', [date]);
  if (!day) return null;

  const { rows } = await query('SELECT meal, label FROM items WHERE date = $1 ORDER BY meal, ord', [date]);
  const meals = { dorucak: [], rucak: [], vecera: [] };
  for (const row of rows) meals[row.meal]?.push(row.label);

  return { date: day.date, weekday: day.weekday, updatedAt: day.updated_at, meals };
}

export async function listDays(from, to) {
  // Један упит за све дане, па слагање у меморији. Позивање getDay по дану
  // би значило једну туру ка бази по дану.
  const { rows } = await query(
    `SELECT d.date, d.weekday, d.updated_at, i.meal, i.label
     FROM days d LEFT JOIN items i ON i.date = d.date
     WHERE d.date BETWEEN $1 AND $2
     ORDER BY d.date, i.meal, i.ord`,
    [from, to],
  );

  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) {
      byDate.set(row.date, {
        date: row.date,
        weekday: row.weekday,
        updatedAt: row.updated_at,
        meals: { dorucak: [], rucak: [], vecera: [] },
      });
    }
    if (row.meal) byDate.get(row.date).meals[row.meal]?.push(row.label);
  }
  return [...byDate.values()];
}

export async function dayRange() {
  return one('SELECT MIN(date) AS first, MAX(date) AS last FROM days');
}

export async function hasMenuFor(date) {
  const row = await one('SELECT 1 AS ok FROM items WHERE date = $1 LIMIT 1', [date]);
  return Boolean(row);
}

export async function allItemTexts() {
  const { rows } = await query('SELECT DISTINCT label FROM items');
  return rows.map((row) => row.label);
}

/* ---------- Претплате ---------- */

export async function saveSubscription(sub, prefs = {}) {
  await query(
    `INSERT INTO subscriptions (endpoint, p256dh, auth, dorucak, rucak, vecera, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh,
                                          auth = excluded.auth,
                                          dorucak = excluded.dorucak,
                                          rucak = excluded.rucak,
                                          vecera = excluded.vecera,
                                          failures = 0,
                                          last_seen_at = excluded.last_seen_at`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth,
      prefs.dorucak !== false, prefs.rucak !== false, prefs.vecera !== false],
  );
}

export async function deleteSubscription(endpoint) {
  await query('DELETE FROM subscriptions WHERE endpoint = $1', [endpoint]);
}

const MEAL_COLUMNS = { dorucak: 'dorucak', rucak: 'rucak', vecera: 'vecera' };

export async function subscribersFor(meal) {
  const column = MEAL_COLUMNS[meal];
  if (!column) throw new Error(`Непознат оброк: ${meal}`);
  const { rows } = await query(`SELECT * FROM subscriptions WHERE ${column} AND failures < 5`);
  return rows;
}

export async function countSubscribers() {
  const row = await one('SELECT COUNT(*)::int AS n FROM subscriptions');
  return row.n;
}

export async function markFailure(endpoint) {
  await query('UPDATE subscriptions SET failures = failures + 1 WHERE endpoint = $1', [endpoint]);
}

export async function markSuccess(endpoint) {
  await query('UPDATE subscriptions SET failures = 0, last_seen_at = now() WHERE endpoint = $1', [endpoint]);
}

/* ---------- Дневник слања ---------- */

export async function alreadySent(meal, date) {
  const row = await one('SELECT 1 AS ok FROM sent_log WHERE meal = $1 AND date = $2', [meal, date]);
  return Boolean(row);
}

/** Последња слања, за преглед преко /health. */
export async function recentSends(limit = 6) {
  const { rows } = await query(
    'SELECT meal, date, sent_at, total, failed FROM sent_log ORDER BY sent_at DESC LIMIT $1',
    [limit],
  );
  return rows;
}

export async function logSend(meal, date, total, failed) {
  await query(
    `INSERT INTO sent_log (meal, date, sent_at, total, failed) VALUES ($1, $2, now(), $3, $4)
     ON CONFLICT (meal, date) DO UPDATE SET sent_at = excluded.sent_at,
                                            total = excluded.total,
                                            failed = excluded.failed`,
    [meal, date, total, failed],
  );
}
