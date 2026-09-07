// Одговори које зове спољни сервис за распоред морају да остану мали.
//
// Сервиси за распоред одбијају велике одговоре уз поруку да је излаз
// превелик и посао приказују као неуспешан, иако је уредно одрађен. Тако
// су обавештења тихо стала: /health је нарастао на преко килобајта, а он
// је био заказан као посао који држи услугу будном.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DB_PATH = './data/responses.db';
process.env.CRON_SECRET = 'tajna-za-test';
process.env.SCHEDULER = 'off';

const { app } = await import('../src/server.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const LIMIT = 64; // бајтова

async function measure(path, { secret = true, method = 'POST' } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: secret ? { 'x-cron-secret': 'tajna-za-test' } : {},
  });
  const body = await response.text();
  return { status: response.status, size: Buffer.byteLength(body), body };
}

test('свака рута коју зове распоред стаје у неколико десетина бајтова', async () => {
  const paths = [
    '/ping',
    '/api/cron/wake',
    '/api/cron/status',
    '/api/cron/ingest',
    '/api/cron/notify/dorucak',
    '/api/cron/notify/rucak',
    '/api/cron/notify/vecera',
  ];

  for (const path of paths) {
    const result = await measure(path);
    assert.ok(
      result.size <= LIMIT,
      `${path} враћа ${result.size} бајтова, највише ${LIMIT}: ${result.body.slice(0, 80)}`,
    );
    assert.ok(result.status >= 200 && result.status < 300, `${path} враћа ${result.status}`);
  }
});

test('и одбијен позив враћа мали одговор', async () => {
  const noSecret = await measure('/api/cron/ingest', { secret: false });
  assert.equal(noSecret.status, 401);
  assert.ok(noSecret.size <= LIMIT, `${noSecret.size} бајтова`);

  const wrongMeal = await measure('/api/cron/notify/uzina');
  assert.equal(wrongMeal.status, 400);
  assert.ok(wrongMeal.size <= LIMIT, `${wrongMeal.size} бајтова`);
});

test('рута за буђење ради и без тајне и на оба метода', async () => {
  for (const method of ['GET', 'POST']) {
    const result = await measure('/ping', { secret: false, method });
    assert.equal(result.status, 200, `${method} /ping`);
    assert.ok(result.size <= LIMIT);
  }
});

test('погрешна путања без /api такође враћа мали одговор', async () => {
  const result = await measure('/cron/notify/rucak', { secret: false, method: 'GET' });
  assert.equal(result.status, 404);
  assert.ok(result.size <= 200, `${result.size} бајтова`);
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('проба најаве не троши прави термин', async () => {
  // Обе руте морају да остану мале, а проба не сме да упише у дневник,
  // иначе би провера поставке обеснажила вечерашњу праву најаву.
  const probno = await measure('/api/cron/notify/dorucak?probno=1');
  assert.equal(probno.status, 200);
  assert.ok(probno.size <= LIMIT, `${probno.size} бајтова`);

  const source = String(await import('node:fs').then((fs) => fs.readFileSync('./src/cron-routes.js', 'utf8')));
  assert.match(source, /force: probno/, 'проба мора да иде као форсирано слање, које не улази у дневник');
});
