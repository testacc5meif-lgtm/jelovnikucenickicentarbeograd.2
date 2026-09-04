import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, MEALS, MEAL_KEYS } from './config.js';
import * as store from './db.js';
import { today, shiftDate, weekdayOf, humanDate } from './dates.js';
import { runIngest } from './ingest.js';
import { sendMealTeaser, pushReady } from './push.js';
import { checkOcr } from './ocr.js';
import { cronRoutes } from './cron-routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

/* ---------- Јавни API ---------- */

app.get('/api/meta', async (req, res) => {
  const range = await store.dayRange();
  const source = await store.latestSource();
  res.json({
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
  });
});

app.get('/api/menu', async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : shiftDate(today(), -1);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : shiftDate(today(), 14);
  res.json({ from, to, days: await store.listDays(from, to) });
});

app.get('/api/day/:date', async (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
    return res.status(400).json({ error: 'Неисправан датум' });
  }
  const day = await store.getDay(req.params.date);
  if (!day) return res.status(404).json({ error: 'Нема јеловника за тај дан' });
  res.json({ ...day, weekdayLabel: weekdayOf(day.date), humanDate: humanDate(day.date) });
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

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    store: store.kind,
    scheduler: config.scheduler,
    cronRoutes: Boolean(config.cronSecret),
    subscribers: await store.countSubscribers(),
    range: await store.dayRange(),
  });
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
