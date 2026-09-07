// Руте које споља позива бесплатан сервис за распоред, кад апликација
// живи на хостингу без сталног процеса.
//
// Чувају их две ствари. Тајна се шаље заглављем, а не у адреси, да не
// заврши у дневницима посредника. Поређење је отпорно на мерење времена,
// да се тајна не може погодити слово по слово.

import crypto from 'node:crypto';
import { Router } from 'express';
import { config, MEALS, MEAL_KEYS } from './config.js';
import { checkSource, notifyMeal, targetDate } from './jobs.js';
import { lastIngest } from './ingest.js';
import { note } from './access-log.js';

const stamp = () => new Date().toISOString();
const log = (...parts) => console.log(`[${stamp()}]`, ...parts);

function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireSecret(req, res, next) {
  const given = req.get('x-cron-secret');
  if (!sameSecret(given, config.cronSecret)) {
    note({
      путања: req.originalUrl,
      метод: req.method,
      исход: given ? 'погрешна тајна' : 'тајна није послата',
    });
    return res.status(401).json(NOT_OK);
  }
  note({ путања: req.originalUrl, метод: req.method, исход: 'прихваћено' });
  return next();
}

// Сваки одговор овде је најмањи могући. Сервиси за распоред одбијају
// одговоре преко неколико стотина бајтова уз поруку да је излаз превелик,
// а посао тада изгледа као да је пао иако је уредно одрађен. Шта се
// стварно десило види се у /health, не у одговору.
const OK = { ok: true };
const NOT_OK = { ok: false };

/**
 * Одговара одмах, па тек онда ради посао.
 *
 * Бесплатан хостинг услугу успављује након неког времена без саобраћаја,
 * а буђење уме да потраје. Сервиси за распоред прекидају везу после
 * тридесетак секунди. Зато одговор не чека да посао заврши: важно је да
 * захтев пробуди процес, а исход стиже у дневник.
 *
 * Одговор је 200, а не 202, јер поједини сервиси за распоред прихватају
 * само 200 као успех.
 */
function background(name, task) {
  return (req, res) => {
    res.json(OK);
    Promise.resolve()
      .then(task)
      .then((result) => log(`${name}:`, JSON.stringify(result)))
      .catch((error) => console.error(`[${stamp()}] ${name} није успело:`, error.message));
  };
}

export function cronRoutes() {
  const router = Router();
  router.use(requireSecret);

  // И GET и POST, јер сервиси за распоред различито подразумевају.
  const both = (path, handler) => {
    router.get(path, handler);
    router.post(path, handler);
  };

  // Буђење пред најаву, да процес не крене из хладног стања баш у тренутку
  // када треба да пошаље обавештења.
  both('/wake', (req, res) => res.json(OK));

  both('/ingest', background('провера извора', () => checkSource({ log })));

  both('/notify/:meal', (req, res, next) => {
    const meal = req.params.meal;
    if (!MEAL_KEYS.includes(meal)) {
      note({ путања: req.originalUrl, метод: req.method, исход: `непознат оброк: ${meal}` });
      return res.status(400).json(NOT_OK);
    }

    // Уз ?probno=1 обавештење се шаље, али се не уписује у дневник, па
    // прави термин остаје слободан. Служи да се поставка провери одмах,
    // уместо чекања на заказано време.
    const probno = req.query.probno === '1';
    const naziv = `најава: ${MEALS[meal].label}${probno ? ' (проба)' : ''}`;
    return background(naziv, () => notifyMeal(meal, { force: probno }))(req, res, next);
  });

  // Сигнал за спољни надзор. Враћа грешку кад је последња обрада одбијена,
  // да сервис за распоред пошаље обавештење уместо да квар прође тихо.
  both('/status', (req, res) => {
    const failed = lastIngest().status === 'одбијено';
    res.status(failed ? 500 : 200).json(failed ? NOT_OK : OK);
  });

  // Преглед онога што спољни распоред треба да позива, да поставка не мора
  // да се преписује ручно из кода.
  router.get('/plan', (req, res) => {
    res.json({
      timezone: config.tz,
      header: 'x-cron-secret',
      jobs: [
        { path: '/api/cron/ingest', cron: config.checkCron, opis: 'провера сајта и обрада новог јеловника' },
        { path: '/api/cron/status', cron: '20 9 * * *', opis: 'надзор: враћа грешку ако је последња обрада одбијена' },
        { path: '/ping', cron: '*/10 5-23 * * *', opis: 'држи услугу будном, без тајне' },
        ...Object.values(MEALS).flatMap((meal) => {
          const [hour, minute] = meal.notifyAt.split(':').map(Number);
          const wake = (hour * 60 + minute - 5 + 1440) % 1440;
          return [
            {
              path: '/api/cron/wake',
              cron: `${wake % 60} ${Math.floor(wake / 60)} * * *`,
              opis: `буђење пред најаву за ${meal.accusative}`,
            },
            {
              path: `/api/cron/notify/${meal.key}`,
              cron: `${minute} ${hour} * * *`,
              opis: `најава за ${meal.accusative}, за дан ${targetDate(meal.key)}`,
            },
          ];
        }),
      ],
    });
  });

  return router;
}
