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

const stamp = () => new Date().toISOString();
const log = (...parts) => console.log(`[${stamp()}]`, ...parts);

function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireSecret(req, res, next) {
  if (!sameSecret(req.get('x-cron-secret'), config.cronSecret)) {
    return res.status(401).json({ error: 'Неисправна тајна' });
  }
  return next();
}

/**
 * Одговара одмах, па тек онда ради посао.
 *
 * Бесплатан хостинг услугу успављује након неког времена без саобраћаја,
 * а буђење уме да потраје. Сервиси за распоред прекидају везу после
 * тридесетак секунди. Зато одговор не чека да посао заврши: важно је да
 * захтев пробуди процес, а исход стиже у дневник.
 */
function background(name, task) {
  return (req, res) => {
    res.status(202).json({ accepted: name, at: stamp() });
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
  both('/wake', (req, res) => res.json({ awake: true, at: stamp() }));

  both('/ingest', background('провера извора', () => checkSource({ log })));

  both('/notify/:meal', (req, res, next) => {
    const meal = req.params.meal;
    if (!MEAL_KEYS.includes(meal)) {
      return res.status(400).json({ error: `Непознат оброк: ${meal}`, poznati: MEAL_KEYS });
    }
    return background(`најава: ${MEALS[meal].label}`, () => notifyMeal(meal))(req, res, next);
  });

  // Преглед онога што спољни распоред треба да позива, да поставка не мора
  // да се преписује ручно из кода.
  router.get('/plan', (req, res) => {
    res.json({
      timezone: config.tz,
      header: 'x-cron-secret',
      jobs: [
        { path: '/api/cron/ingest', cron: config.checkCron, opis: 'провера сајта и обрада новог јеловника' },
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
