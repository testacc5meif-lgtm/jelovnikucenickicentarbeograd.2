// Складиште на SQLite, преко уграђеног `node:sqlite`, без спољних зависности.
// Користи се локално и на серверу са диском. Све функције су async, иако
// SQLite ради синхроно, да би оба складишта имала исти облик.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sources (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    url          TEXT NOT NULL,
    sha256       TEXT NOT NULL UNIQUE,
    bytes        INTEGER NOT NULL,
    period_from  TEXT,
    period_to    TEXT,
    allergens    TEXT,
    note         TEXT,
    fetched_at   TEXT NOT NULL,
    day_count    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS days (
    date       TEXT PRIMARY KEY,
    weekday    TEXT NOT NULL,
    source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    date  TEXT NOT NULL REFERENCES days(date) ON DELETE CASCADE,
    meal  TEXT NOT NULL,
    ord   INTEGER NOT NULL,
    label TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS items_by_day ON items(date, meal, ord);

  CREATE TABLE IF NOT EXISTS subscriptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint     TEXT NOT NULL UNIQUE,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    dorucak      INTEGER NOT NULL DEFAULT 1,
    rucak        INTEGER NOT NULL DEFAULT 1,
    vecera       INTEGER NOT NULL DEFAULT 1,
    failures     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sent_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    meal    TEXT NOT NULL,
    date    TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    total   INTEGER NOT NULL,
    failed  INTEGER NOT NULL,
    UNIQUE(meal, date)
  );
`);

const now = () => new Date().toISOString();

export const kind = 'sqlite';

export async function close() {
  db.close();
}

/* ---------- Извори ---------- */

export async function findSourceByHash(sha256) {
  return db.prepare('SELECT * FROM sources WHERE sha256 = ?').get(sha256) ?? null;
}

export async function insertSource(source) {
  const info = db.prepare(`
    INSERT INTO sources (url, sha256, bytes, period_from, period_to, allergens, note, fetched_at, day_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source.url, source.sha256, source.bytes, source.periodFrom, source.periodTo,
    source.allergens, source.note, now(), source.dayCount,
  );
  return Number(info.lastInsertRowid);
}

export async function latestSource() {
  return db.prepare('SELECT * FROM sources ORDER BY id DESC LIMIT 1').get() ?? null;
}

/* ---------- Дани и ставке ---------- */

export async function upsertDay(sourceId, day) {
  db.prepare('DELETE FROM items WHERE date = ?').run(day.date);
  db.prepare(`
    INSERT INTO days (date, weekday, source_id, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET weekday = excluded.weekday,
                                    source_id = excluded.source_id,
                                    updated_at = excluded.updated_at
  `).run(day.date, day.weekday, sourceId, now());

  const insert = db.prepare('INSERT INTO items (date, meal, ord, label) VALUES (?, ?, ?, ?)');
  for (const meal of ['dorucak', 'rucak', 'vecera']) {
    (day[meal] || []).forEach((label, index) => insert.run(day.date, meal, index, label));
  }
}

export async function getDay(date) {
  const day = db.prepare('SELECT * FROM days WHERE date = ?').get(date);
  if (!day) return null;

  const rows = db.prepare('SELECT meal, label FROM items WHERE date = ? ORDER BY meal, ord').all(date);
  const meals = { dorucak: [], rucak: [], vecera: [] };
  for (const row of rows) meals[row.meal]?.push(row.label);

  return { date: day.date, weekday: day.weekday, updatedAt: day.updated_at, meals };
}

export async function listDays(from, to) {
  const dates = db.prepare('SELECT date FROM days WHERE date BETWEEN ? AND ? ORDER BY date').all(from, to);
  const days = [];
  for (const row of dates) days.push(await getDay(row.date));
  return days;
}

export async function dayRange() {
  return db.prepare('SELECT MIN(date) AS first, MAX(date) AS last FROM days').get();
}

export async function hasMenuFor(date) {
  return db.prepare('SELECT COUNT(*) AS n FROM items WHERE date = ?').get(date).n > 0;
}

export async function allItemTexts() {
  return db.prepare('SELECT DISTINCT label FROM items').all().map((row) => row.label);
}

/* ---------- Претплате ---------- */

export async function saveSubscription(sub, prefs = {}) {
  db.prepare(`
    INSERT INTO subscriptions (endpoint, p256dh, auth, dorucak, rucak, vecera, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh,
                                        auth = excluded.auth,
                                        dorucak = excluded.dorucak,
                                        rucak = excluded.rucak,
                                        vecera = excluded.vecera,
                                        failures = 0,
                                        last_seen_at = excluded.last_seen_at
  `).run(
    sub.endpoint, sub.keys.p256dh, sub.keys.auth,
    prefs.dorucak === false ? 0 : 1,
    prefs.rucak === false ? 0 : 1,
    prefs.vecera === false ? 0 : 1,
    now(), now(),
  );
}

export async function deleteSubscription(endpoint) {
  db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(endpoint);
}

export async function subscribersFor(meal) {
  return db.prepare(`SELECT * FROM subscriptions WHERE ${meal} = 1 AND failures < 5`).all();
}

export async function countSubscribers() {
  return db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n;
}

export async function markFailure(endpoint) {
  db.prepare('UPDATE subscriptions SET failures = failures + 1 WHERE endpoint = ?').run(endpoint);
}

export async function markSuccess(endpoint) {
  db.prepare('UPDATE subscriptions SET failures = 0, last_seen_at = ? WHERE endpoint = ?').run(now(), endpoint);
}

/* ---------- Дневник слања ---------- */

export async function alreadySent(meal, date) {
  return Boolean(db.prepare('SELECT 1 FROM sent_log WHERE meal = ? AND date = ?').get(meal, date));
}

/** Последња слања, за преглед преко /health. */
export async function recentSends(limit = 6) {
  return db.prepare('SELECT meal, date, sent_at, total, failed FROM sent_log ORDER BY sent_at DESC LIMIT ?').all(limit);
}

export async function logSend(meal, date, total, failed) {
  db.prepare(`
    INSERT INTO sent_log (meal, date, sent_at, total, failed) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(meal, date) DO UPDATE SET sent_at = excluded.sent_at,
                                          total = excluded.total,
                                          failed = excluded.failed
  `).run(meal, date, now(), total, failed);
}
