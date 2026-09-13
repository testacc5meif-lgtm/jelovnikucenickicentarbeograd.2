import 'dotenv/config';
import path from 'node:path';

export const config = {
  port: Number(process.env.PORT || 3000),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  sourceUrl: process.env.SOURCE_URL || 'https://www.ucenickicentar-bg.rs/sluzba-ishrane/',
  // Ако је адреса подешена, ради Postgres. Иначе SQLite фајл.
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: process.env.DATABASE_SSL !== 'false',
  dbPath: path.resolve(process.env.DB_PATH || './data/jelovnik.db'),
  tz: process.env.TZ_NAME || 'Europe/Belgrade',
  checkCron: process.env.CHECK_CRON || '7 * * * *',
  adminToken: process.env.ADMIN_TOKEN || '',
  // "internal" држи распоред у самом процесу, што важи за сервер који
  // стално ради. "off" га гаси, па послове позива спољни сервис преко
  // рута под /api/cron.
  scheduler: process.env.SCHEDULER || 'internal',
  cronSecret: process.env.CRON_SECRET || '',
  ocr: {
    binary: process.env.TESSERACT_BIN || 'tesseract',
    tessdata: path.resolve(process.env.TESSDATA_DIR || './tessdata'),
    lang: process.env.OCR_LANG || 'srp',
  },
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  },
};

/**
 * Оброци: када почињу, када иде најава и на који дан се та најава односи.
 *
 * `startsAt` и `endsAt` су време служења. Оброк траје, није тренутак, па
 * без краја апликација већ у 18:40 пише да је вечера прошла иако се служи
 * до 20:30.
 *
 * `startsAt` и `endsAt` уз сам оброк су сатница радних дана. Субота и
 * недеља стоје у `SCHEDULE` испод.
 *
 * `targetDayOffset` се броји од дана слања. Доручак се најављује у 22:30
 * за сутра, па је помак 1. Ручак и вечера се најављују истог дана.
 * `accusative` служи реченицама попут „најава за вечеру".
 */
export const MEALS = {
  dorucak: { key: 'dorucak', label: 'Доручак', accusative: 'доручак', startsAt: '06:30', endsAt: '07:30', notifyAt: '22:30', targetDayOffset: 1 },
  rucak:   { key: 'rucak',   label: 'Ручак',   accusative: 'ручак',   startsAt: '11:30', endsAt: '15:00', notifyAt: '10:30', targetDayOffset: 0 },
  vecera:  { key: 'vecera',  label: 'Вечера',  accusative: 'вечеру',  startsAt: '18:30', endsAt: '20:30', notifyAt: '17:30', targetDayOffset: 0 },
};

export const MEAL_KEYS = Object.keys(MEALS);

/**
 * Сатница по врсти дана.
 *
 * Радним данима важи оно што стоји уз сам оброк. Субота и недеља имају
 * своју: доручак касније, ручак краће, а вечера се не служи у трпезарији
 * него се на ручку добија ланч пакет.
 *
 * `null` значи да оброк тог дана нема своје време служења. Такав оброк не
 * улази у рачун шта се управо служи и за њега не иде најава.
 */
export const SCHEDULE = {
  radni: {
    dorucak: { startsAt: '06:30', endsAt: '07:30' },
    rucak: { startsAt: '11:30', endsAt: '15:00' },
    vecera: { startsAt: '18:30', endsAt: '20:30' },
  },
  subota: {
    dorucak: { startsAt: '07:30', endsAt: '08:15' },
    rucak: { startsAt: '12:00', endsAt: '14:00' },
    vecera: null,
  },
  nedelja: {
    dorucak: { startsAt: '07:30', endsAt: '08:15' },
    rucak: { startsAt: '12:00', endsAt: '13:00' },
    vecera: null,
  },
};
