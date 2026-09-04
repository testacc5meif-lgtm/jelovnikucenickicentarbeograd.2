// Провера Postgres складишта на правој бази.
//
// Подиже се преносиви Postgres, без инсталације на систем. Ако тих
// бинарних фајлова нема, тестови се прескачу, да поставка пројекта не
// зависи од њих. За проверу на самом Supabase-у довољно је покренути:
//   DATABASE_URL=<адреса> node --test test/postgres.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const MEALS = ['dorucak', 'rucak', 'vecera'];

let server = null;
let dataDir = null;

async function startDatabase() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import('embedded-postgres'));
  } catch {
    return null;
  }

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jelovnik-pg-'));
  // Намерно другачији порт од оног за развој, да се не сударају.
  const port = Number(process.env.PG_TEST_PORT || 54331);

  server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });

  await server.initialise();
  await server.start();

  // Базу правимо ручно, са изричитим UTF8 кодирањем. Подразумевано
  // кодирање прати локалне поставке Windows-а, што овде даје WIN1252,
  // у коме ћирилица не може да се упише. Supabase је UTF8.
  const { default: pg } = await import('pg');
  const admin = new pg.Client({
    connectionString: `postgres://postgres:postgres@localhost:${port}/postgres`,
  });
  await admin.connect();
  await admin.query("CREATE DATABASE jelovnik WITH ENCODING 'UTF8' TEMPLATE template0");
  await admin.end();

  return `postgres://postgres:postgres@localhost:${port}/jelovnik`;
}

const url = await startDatabase();
const skip = url ? false : 'преносиви Postgres није доступан';

// Складиште чита адресу из окружења при учитавању, па се поставља пре тога.
if (url) {
  process.env.DATABASE_URL = url;
  process.env.DATABASE_SSL = 'false';
}

const store = url ? await import('../src/store/postgres.js') : null;
if (store) await store.migrate();

test('Postgres: дан се уписује и чита у истом облику као из SQLite-а', { skip }, async () => {
  const sourceId = await store.insertSource({
    url: 'https://primer.rs/jelovnik.pdf',
    sha256: 'hash-jedan',
    bytes: 1234,
    periodFrom: '2026-09-01',
    periodTo: '2026-09-02',
    allergens: 'глутен, јаја',
    note: 'напомена',
    dayCount: 1,
  });

  await store.upsertDay(sourceId, {
    date: '2026-09-01',
    weekday: 'уторак',
    dorucak: ['чај, млеко, јогурт', 'зденка сир 2'],
    rucak: ['јунећа супа'],
    vecera: [],
  });

  const day = await store.getDay('2026-09-01');
  assert.equal(day.date, '2026-09-01', 'датум остаје низ, не претвара се у објекат');
  assert.equal(day.weekday, 'уторак');
  assert.deepEqual(day.meals.dorucak, ['чај, млеко, јогурт', 'зденка сир 2']);
  assert.deepEqual(day.meals.rucak, ['јунећа супа']);
  assert.deepEqual(day.meals.vecera, []);
});

test('Postgres: поновни упис истог дана мења ставке, не удвостручава их', { skip }, async () => {
  const sourceId = await store.insertSource({
    url: 'https://primer.rs/drugi.pdf',
    sha256: 'hash-dva',
    bytes: 10,
    periodFrom: '2026-09-01',
    periodTo: '2026-09-01',
    allergens: '',
    note: '',
    dayCount: 1,
  });

  await store.upsertDay(sourceId, {
    date: '2026-09-01', weekday: 'уторак', dorucak: ['нови доручак'], rucak: [], vecera: [],
  });

  const day = await store.getDay('2026-09-01');
  assert.deepEqual(day.meals.dorucak, ['нови доручак']);
});

test('Postgres: већ обрађен PDF се препознаје по отиску', { skip }, async () => {
  assert.ok(await store.findSourceByHash('hash-jedan'));
  assert.equal(await store.findSourceByHash('нема-овога'), null);
});

test('Postgres: распон и списак дана враћају чисте датуме', { skip }, async () => {
  const range = await store.dayRange();
  assert.equal(range.first, '2026-09-01');

  const days = await store.listDays('2026-08-01', '2026-10-01');
  assert.equal(days.length, 1);
  assert.equal(days[0].date, '2026-09-01');
  assert.ok(Array.isArray(days[0].meals.dorucak));
});

test('Postgres: речник се чита из уписаних ставки', { skip }, async () => {
  const texts = await store.allItemTexts();
  assert.ok(texts.includes('нови доручак'));
});

test('Postgres: претплата се чува, мења и брише', { skip }, async () => {
  const subscription = {
    endpoint: 'https://push.primer.rs/abc',
    keys: { p256dh: 'kljuc', auth: 'tajna' },
  };

  await store.saveSubscription(subscription, { dorucak: true, rucak: true, vecera: false });
  assert.equal(await store.countSubscribers(), 1);
  assert.equal((await store.subscribersFor('dorucak')).length, 1);
  assert.equal((await store.subscribersFor('vecera')).length, 0, 'искључен оброк се не шаље');

  // Поновна претплата истим уређајем мења подешавања, не прави нови ред.
  await store.saveSubscription(subscription, { dorucak: false, rucak: true, vecera: true });
  assert.equal(await store.countSubscribers(), 1);
  assert.equal((await store.subscribersFor('vecera')).length, 1);

  await store.deleteSubscription(subscription.endpoint);
  assert.equal(await store.countSubscribers(), 0);
});

test('Postgres: дневник слања спречава двоструку најаву', { skip }, async () => {
  assert.equal(await store.alreadySent('rucak', '2026-09-01'), false);
  await store.logSend('rucak', '2026-09-01', 5, 1);
  assert.equal(await store.alreadySent('rucak', '2026-09-01'), true);
  await store.logSend('rucak', '2026-09-01', 7, 0);
  assert.equal(await store.alreadySent('rucak', '2026-09-01'), true);
});

test('Postgres: мени постоји само за дан који има ставке', { skip }, async () => {
  assert.equal(await store.hasMenuFor('2026-09-01'), true);
  assert.equal(await store.hasMenuFor('2026-12-25'), false);
});

test('оба складишта нуде исти скуп функција', async () => {
  const sqlite = await import('../src/store/sqlite.js');
  const pg = await import('../src/store/postgres.js');
  const shared = Object.keys(sqlite).filter((name) => typeof sqlite[name] === 'function');
  for (const name of shared) {
    assert.equal(typeof pg[name], 'function', `Postgres складиште нема ${name}`);
  }
});

test.after(async () => {
  if (store) await store.close();
  if (server) await server.stop();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});
