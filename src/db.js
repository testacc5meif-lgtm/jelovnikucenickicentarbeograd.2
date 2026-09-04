// Бира складиште према окружењу и износи исти скуп функција.
//
// Ако је `DATABASE_URL` подешен, ради се на Postgres-у, што важи за
// Supabase и сваки други хостовани Postgres. Иначе ради SQLite фајл, што
// је довољно локално и на серверу са диском. Остатак система не зна
// коју базу користи, јер су обе иза истог, увек асинхроног облика.

import { config } from './config.js';

const store = config.databaseUrl
  ? await import('./store/postgres.js')
  : await import('./store/sqlite.js');

if (store.migrate) await store.migrate();

export const kind = store.kind;

export const {
  close,
  findSourceByHash,
  insertSource,
  latestSource,
  upsertDay,
  getDay,
  listDays,
  dayRange,
  hasMenuFor,
  allItemTexts,
  saveSubscription,
  deleteSubscription,
  subscribersFor,
  countSubscribers,
  markFailure,
  markSuccess,
  alreadySent,
  logSend,
} = store;
