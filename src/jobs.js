// Периодични послови, независни од тога ко их покреће.
//
// Исте функције користи и унутрашњи распоред на серверу који стално ради,
// и HTTP руте које споља позива бесплатан сервис за распоред, кад
// апликација живи на хостингу без сталног процеса.

import { runIngest } from './ingest.js';
import { sendMealTeaser } from './push.js';
import { MEALS, MEAL_KEYS } from './config.js';
import { today, shiftDate } from './dates.js';

/**
 * Дан за који се шаље најава.
 * Доручак се најављује увече за сутра, ручак и вечера истог дана.
 */
export function targetDate(mealKey, now = new Date()) {
  const meal = MEALS[mealKey];
  if (!meal) throw new Error(`Непознат оброк: ${mealKey}`);
  return shiftDate(today(now), meal.targetDayOffset);
}

/** Провера сајта и обрада новог јеловника. */
export async function checkSource(options = {}) {
  return runIngest(options);
}

/** Најава једног оброка. */
export async function notifyMeal(mealKey, { date, force = false } = {}) {
  if (!MEAL_KEYS.includes(mealKey)) throw new Error(`Непознат оброк: ${mealKey}`);
  return sendMealTeaser(mealKey, date || targetDate(mealKey), { force });
}

export { MEAL_KEYS };
