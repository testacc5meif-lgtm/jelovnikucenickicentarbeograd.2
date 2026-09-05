import webpush from 'web-push';
import { config, MEALS } from './config.js';
import { pickMessage } from './messages.js';
import * as store from './db.js';

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  if (!config.vapid.publicKey || !config.vapid.privateKey) return false;
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  configured = true;
  return true;
}

export function pushReady() {
  return ensureConfigured();
}

async function sendOne(row, payload) {
  const subscription = {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 3600 });
    await store.markSuccess(row.endpoint);
    return { ok: true };
  } catch (error) {
    // 404 и 410 значе да претплата више не постоји на страни прегледача.
    if (error.statusCode === 404 || error.statusCode === 410) {
      await store.deleteSubscription(row.endpoint);
    } else {
      await store.markFailure(row.endpoint);
    }
    return { ok: false, status: error.statusCode, message: error.message };
  }
}

/**
 * Шаље најаву за један оброк одређеног дана.
 *
 * Не шаље ништа ако мени за тај дан не постоји или је најава већ послата.
 * Дневник слања је та брана против двоструке најаве.
 *
 * Пробно слање (`force`) намерно **не** улази у дневник. Иначе би проба
 * зачепила прави термин: пошаљеш пробу у поноћ, а редовна најава у 10:30
 * види да је за тај дан већ послато и прескочи. То се и десило.
 */
export async function sendMealTeaser(mealKey, targetDate, { force = false } = {}) {
  if (!ensureConfigured()) return { skipped: 'VAPID кључеви нису подешени' };
  if (!(await store.hasMenuFor(targetDate))) return { skipped: `нема менија за ${targetDate}` };
  if (!force && (await store.alreadySent(mealKey, targetDate))) return { skipped: 'већ послато' };

  const meal = MEALS[mealKey];
  const message = pickMessage(mealKey, targetDate);
  const payload = {
    title: message.title,
    body: message.body,
    url: `${config.publicUrl}/?dan=${targetDate}&obrok=${mealKey}`,
    tag: `${mealKey}-${targetDate}`,
    meal: mealKey,
    mealLabel: meal.label,
    date: targetDate,
  };

  const rows = await store.subscribersFor(mealKey);
  const results = await Promise.all(rows.map((row) => sendOne(row, payload)));
  const failed = results.filter((result) => !result.ok).length;
  if (!force) await store.logSend(mealKey, targetDate, rows.length, failed);

  return { meal: mealKey, date: targetDate, total: rows.length, failed, title: payload.title, forced: force };
}
