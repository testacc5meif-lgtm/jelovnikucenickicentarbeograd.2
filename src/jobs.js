// Периодични послови, независни од тога ко их покреће.
//
// Исте функције користи и унутрашњи распоред на серверу који стално ради,
// и HTTP руте које споља позива бесплатан сервис за распоред, кад
// апликација живи на хостингу без сталног процеса.

import { runIngest } from './ingest.js';
import { sendMealTeaser } from './push.js';
import { MEALS, MEAL_KEYS } from './config.js';
import { today, shiftDate, minutesNow, mealTimes } from './dates.js';

/**
 * Дан за који се шаље најава.
 * Доручак се најављује увече за сутра, ручак и вечера истог дана.
 */
export function targetDate(mealKey, now = new Date()) {
  const meal = MEALS[mealKey];
  if (!meal) throw new Error(`Непознат оброк: ${mealKey}`);
  return shiftDate(today(now), meal.targetDayOffset);
}

const toMinutes = (time) => {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
};

/** Пре овог сата се не шаље ништа. Ноћу се људи не буде због јеловника. */
const TISINA_DO = 6 * 60;

/**
 * Најаве које су пропуштене зато што јеловника тада још није било.
 *
 * Нови јеловник излази двапут месечно и никад тачно у поноћ. Док не
 * стигне, свака најава за те дане се прескаче, а прескочена се не понавља
 * сама. Шеснаестог у десет и по није имало шта да се јави за ручак, а ако
 * PDF стигне у једанаест, порука више не би стигла никад.
 *
 * Зато се, чим нови јеловник уђе у базу, надокнађује оно што је пропало.
 * Дневник слања и даље брани од двоструке поруке.
 *
 * Правила су ужа него за редовну најаву, да надокнада не звони без везе:
 * оброк који је истог дана већ прошао се не најављује, ручак и вечера
 * чекају свој термин ако још није дошао, а ноћу се не шаље ништа.
 * Доручак је изузет од чекања на термин, јер је његов термин синоћ и
 * управо је он пропао.
 */
export async function catchUpNotifications({ now = new Date(), log = () => {} } = {}) {
  const danas = today(now);
  const sada = minutesNow(now);
  const poslato = [];

  for (const key of MEAL_KEYS) {
    const meal = MEALS[key];
    const dani = new Set([danas]);
    if (sada >= toMinutes(meal.notifyAt)) dani.add(targetDate(key, now));

    for (const date of dani) {
      const times = mealTimes(key, date);
      if (!times) continue;
      if (date === danas) {
        if (sada >= toMinutes(times.endsAt)) continue;
        if (meal.targetDayOffset === 0 && sada < toMinutes(meal.notifyAt)) continue;
        if (sada < TISINA_DO) continue;
      }
      const ishod = await notifyMeal(key, { date });
      log(`надокнада најаве: ${meal.label} за ${date}: ${JSON.stringify(ishod)}`);
      if (!ishod.skipped) poslato.push(ishod);
    }
  }

  return poslato;
}

/**
 * Провера сајта и обрада новог јеловника.
 *
 * Ако је нешто уписано, одмах се надокнађују најаве које су пропале док
 * јеловника још није било.
 */
export async function checkSource(options = {}) {
  const ishod = await runIngest(options);
  if (ishod.processed.length > 0) {
    ishod.caughtUp = await catchUpNotifications(options);
  }
  return ishod;
}

/** Најава једног оброка. */
export async function notifyMeal(mealKey, { date, force = false } = {}) {
  if (!MEAL_KEYS.includes(mealKey)) throw new Error(`Непознат оброк: ${mealKey}`);
  return sendMealTeaser(mealKey, date || targetDate(mealKey), { force });
}

export { MEAL_KEYS };
