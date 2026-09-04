#!/usr/bin/env node
// Ручно слање најаве, за проверу да нотификације стижу.
//   node scripts/send-test.js rucak
//   node scripts/send-test.js dorucak 2026-09-04
import { sendMealTeaser } from '../src/push.js';
import { MEAL_KEYS } from '../src/config.js';
import { today, shiftDate } from '../src/dates.js';

const meal = process.argv[2];
if (!MEAL_KEYS.includes(meal)) {
  console.error(`Употреба: node scripts/send-test.js <${MEAL_KEYS.join('|')}> [YYYY-MM-DD]`);
  process.exit(1);
}

const date = process.argv[3] || (meal === 'dorucak' ? shiftDate(today(), 1) : today());
const result = await sendMealTeaser(meal, date, { force: true });
console.log(result);
