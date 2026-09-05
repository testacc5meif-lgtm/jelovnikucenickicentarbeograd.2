import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, MEALS, MEAL_KEYS } from './config.js';
import * as store from './db.js';
import { today, shiftDate, weekdayOf, humanDate } from './dates.js';
import { runIngest, lastIngest } from './ingest.js';
import { sendMealTeaser, pushReady } from './push.js';
import { checkOcr } from './ocr.js';
import { cronRoutes } from './cron-routes.js';
import { remember, recall } from './last-good.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

/* ---------- Јавни API ---------- */

/**
 * Читање отпорно на кратак прекид базе.
 *
 * Кад упит не успе, враћа се последњи успешно прочитан одговор уз ознаку
 * да су подаци застарели. Празан екран уз грешку је најгори исход, јер
 * јеловник од јуче је готово увек и данашњи јеловник.
 */
async function serveRead(req, res, produce) {
  const key = req.originalUrl;
  try {
    const data = await produce();
    remember(key, data);
    return res.json(data);
  } catch (error) {
    if (error.notFound) return res.status(404).json({ error: error.message });

    console.error(`Читање није успело (${key}): ${error.message}`);
    const fallback = recall(key);
    if (fallback) {
      return res.json({ ...fallback.data, stale: true, staleSince: fallback.at });
    }
    return res.status(503).json({ error: 'База тренутно није доступна', stale: true });
  }
}

app.get('/api/meta', (req, res) => serveRead(req, res, async () => {
  const range = await store.dayRange();
  const source = await store.latestSource();
  return {
    vapidPublicKey: config.vapid.publicKey || null,
    pushEnabled: pushReady(),
    meals: MEAL_KEYS.map((key) => MEALS[key]),
    today: today(),
    range,
    source: source
      ? {
          periodFrom: source.period_from,
          periodTo: source.period_to,
          allergens: source.allergens,
          note: source.note,
          fetchedAt: source.fetched_at,
          url: source.url,
        }
      : null,
  };
}));

app.get('/api/menu', (req, res) => serveRead(req, res, async () => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : shiftDate(today(), -1);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : shiftDate(today(), 14);
  return { from, to, days: await store.listDays(from, to) };
}));

app.get('/api/day/:date', (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
    return res.status(400).json({ error: 'Неисправан датум' });
  }
  return serveRead(req, res, async () => {
    const day = await store.getDay(req.params.date);
    // Недостатак јеловника за један дан је обичан исход, не квар, па се
    // не памти као успешно читање и не приказује као застарео податак.
    if (!day) {
      const missing = new Error('Нема јеловника за тај дан');
      missing.notFound = true;
      throw missing;
    }
    return { ...day, weekdayLabel: weekdayOf(day.date), humanDate: humanDate(day.date) };
  });
});

/* ---------- Претплате ---------- */

function validSubscription(body) {
  return Boolean(
    body?.subscription?.endpoint &&
      body.subscription.keys?.p256dh &&
      body.subscription.keys?.auth,
  );
}

app.post('/api/subscribe', async (req, res) => {
  if (!validSubscription(req.body)) return res.status(400).json({ error: 'Неисправна претплата' });
  await store.saveSubscription(req.body.subscription, req.body.prefs || {});
  res.json({ ok: true });
});

app.post('/api/unsubscribe', async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'Недостаје endpoint' });
  await store.deleteSubscription(endpoint);
  res.json({ ok: true });
});

/* ---------- Административне руте ---------- */

function requireAdmin(req, res, next) {
  if (!config.adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN није подешен' });
  if (req.get('x-admin-token') !== config.adminToken) return res.status(401).json({ error: 'Неовлашћен приступ' });
  next();
}

app.post('/api/admin/ingest', requireAdmin, async (req, res) => {
  try {
    res.json(await runIngest());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/notify', requireAdmin, async (req, res) => {
  const meal = req.body?.meal;
  if (!MEAL_KEYS.includes(meal)) return res.status(400).json({ error: 'Непознат оброк' });
  const date = req.body?.date || (meal === 'dorucak' ? shiftDate(today(), 1) : today());
  try {
    res.json(await sendMealTeaser(meal, date, { force: true }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Руте за спољни распоред постоје само кад је тајна подешена.
if (config.cronSecret) app.use('/api/cron', cronRoutes());

// Стање сервера мора да одговори и кад база не ради, иначе хостинг мисли
// да је услуга мртва и гаси је баш кад треба да сачека да се база врати.
app.get('/health', async (req, res) => {
  const db = await store.ready;
  const body = {
    ok: true,
    database: db.ok ? 'спремна' : `није спремна: ${db.reason}`,
    store: store.kind,
    scheduler: config.scheduler,
    cronRoutes: Boolean(config.cronSecret),
    lastIngest: lastIngest(),
  };

  try {
    body.subscribers = await store.countSubscribers();
    body.range = await store.dayRange();
    // Без овога се пропуштена најава не види споља, него се о њој само
    // нагађа. Дневник каже да ли је слање уопште покушано.
    body.recentSends = await store.recentSends();
  } catch (error) {
    body.database = `не одговара: ${error.message}`;
  }

  res.json(body);
});

// Свака неухваћена грешка у API рути враћа JSON, не HTML страну са
// трагом извршавања. Express 5 сам прослеђује и грешке из async рута.
app.use('/api', (error, req, res, next) => {
  console.error(`Грешка у ${req.originalUrl}: ${error.message}`);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'Грешка на серверу' });
});

// Непостојећа API путања мора да врати 404, а не почетну страну.
// Без овога свака грешка у адреси изгледа као да рута постоји.
app.use('/api', (req, res) => res.status(404).json({ error: 'Непозната рута' }));

/* ---------- Статички фајлови ---------- */

app.use(
  express.static(publicDir, {
    setHeaders(res, filePath) {
      // Service worker се не сме кеширати, иначе се нове верзије не примају.
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.get('/{*any}', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

if (process.env.NODE_ENV !== 'test') {
  const { startScheduler } = await import('./scheduler.js');

  // Недоступна база не сме да обори процес: сервер креће, руте за читање
  // се сналазе са последњим успешним одговором, а веза се сама поправи.
  store.ready.then((db) => {
    if (!db.ok) console.error(`Упозорење: база није спремна. ${db.reason}`);
  });

  app.listen(config.port, () => {
    console.log(`Јеловник ради на http://localhost:${config.port}`);
    if (!config.vapid.publicKey) console.warn('Упозорење: VAPID кључеви нису подешени, нотификације су искључене.');
    checkOcr().then((ocr) => {
      if (!ocr.ok) console.warn(`Упозорење: обрада PDF-а неће радити. ${ocr.reason}`);
      else console.log(`OCR спреман: ${ocr.version}`);
    });
    startScheduler();
  });
}

export { app };
