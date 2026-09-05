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

export const kind = store.kind;

/**
 * Недоступна база не сме да обори процес.
 *
 * Раније је грешка при припреми шеме рушила подизање, па је услуга улазила
 * у круг рестартовања и апликација је била потпуно недоступна. Сада се
 * покушај понавља у позадини, сервер ради, а руте за читање се саме сналазе
 * са последњим успешно прочитаним подацима.
 */
export const ready = (async () => {
  if (!store.migrate) return { ok: true };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await store.migrate();
      return { ok: true };
    } catch (error) {
      const last = attempt === 3;
      console.error(`База није спремна (покушај ${attempt}/3): ${error.message}`);
      if (last) return { ok: false, reason: error.message };
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  return { ok: false, reason: 'непознато' };
})();

// Упозорење на тихо назадовање: без адресе базе на серверу подаци иду у
// фајл који нестаје при сваком новом постављању.
if (config.databaseUrl === '' && process.env.NODE_ENV === 'production') {
  console.warn(
    'Упозорење: DATABASE_URL није подешен, па се ради на SQLite фајлу. '
    + 'На хостингу који не чува диск ти подаци нестају при сваком постављању.',
  );
}

/**
 * Свака операција прво сачека припрему шеме.
 *
 * Припрема више не блокира учитавање модула, да недоступна база не обори
 * процес. Без овог чекања упити би кренули пре него што таблице постоје.
 * `ready` никад не одбија, само јавља да ли је успело, па ово чекање само
 * поставља редослед.
 */
function gated(fn) {
  return async (...args) => {
    await ready;
    return fn(...args);
  };
}

export const close = store.close;

export const findSourceByHash = gated(store.findSourceByHash);
export const insertSource = gated(store.insertSource);
export const latestSource = gated(store.latestSource);
export const upsertDay = gated(store.upsertDay);
export const getDay = gated(store.getDay);
export const listDays = gated(store.listDays);
export const dayRange = gated(store.dayRange);
export const hasMenuFor = gated(store.hasMenuFor);
export const allItemTexts = gated(store.allItemTexts);
export const saveSubscription = gated(store.saveSubscription);
export const deleteSubscription = gated(store.deleteSubscription);
export const subscribersFor = gated(store.subscribersFor);
export const countSubscribers = gated(store.countSubscribers);
export const markFailure = gated(store.markFailure);
export const markSuccess = gated(store.markSuccess);
export const alreadySent = gated(store.alreadySent);
export const logSend = gated(store.logSend);
export const recentSends = gated(store.recentSends);
