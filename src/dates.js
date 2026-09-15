import { config, SCHEDULE } from './config.js';

const ISO = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.tz,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const WEEKDAYS = ['недеља', 'понедељак', 'уторак', 'среда', 'четвртак', 'петак', 'субота'];
const MONTHS = [
  'јануар', 'фебруар', 'март', 'април', 'мај', 'јун',
  'јул', 'август', 'септембар', 'октобар', 'новембар', 'децембар',
];

const CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.tz,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Минути од поноћи у зони установе. */
export function minutesNow(at = new Date()) {
  const [hour, minute] = CLOCK.format(at).split(':').map(Number);
  return hour * 60 + minute;
}

/** Данашњи датум у зони установе, као "YYYY-MM-DD". */
export function today(at = new Date()) {
  return ISO.format(at);
}

/** Помера ISO датум за задат број дана. */
export function shiftDate(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return moved.toISOString().slice(0, 10);
}

/** Дан у недељи на ћирилици за ISO датум. */
export function weekdayOf(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Врста дана за ISO датум: "radni", "subota" или "nedelja". */
export function dayKind(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const index = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (index === 6) return 'subota';
  if (index === 0) return 'nedelja';
  return 'radni';
}

/**
 * Време служења оброка тог дана, или `null` кад тог дана нема своје
 * време. Викендом вечера нема, добија се као ланч пакет на ручку.
 */
export function mealTimes(mealKey, isoDate) {
  return SCHEDULE[dayKind(isoDate)][mealKey] || null;
}

/** Читљив запис датума, нпр. "3. септембар". */
export function humanDate(isoDate) {
  const [, m, d] = isoDate.split('-').map(Number);
  return `${d}. ${MONTHS[m - 1]}`;
}
