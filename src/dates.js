import { config } from './config.js';

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

/** Читљив запис датума, нпр. "3. септембар". */
export function humanDate(isoDate) {
  const [, m, d] = isoDate.split('-').map(Number);
  return `${d}. ${MONTHS[m - 1]}`;
}
