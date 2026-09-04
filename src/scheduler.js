import cron from 'node-cron';
import { config, MEALS } from './config.js';
import { checkSource, notifyMeal } from './jobs.js';

const stamp = () => new Date().toISOString();
const log = (...parts) => console.log(`[${stamp()}]`, ...parts);

async function safely(name, task) {
  try {
    log(`${name}:`, JSON.stringify(await task()));
  } catch (error) {
    console.error(`[${stamp()}] ${name} није успело:`, error.message);
  }
}

/**
 * Покреће периодичне послове унутар самог процеса.
 *
 * Ово ради само тамо где процес стално живи, дакле на серверу или
 * виртуелној машини. На хостингу који услугу успављује између захтева
 * распоред се искључује са `SCHEDULER=off`, а послове споља позива
 * бесплатан сервис за распоред, преко рута под `/api/cron`.
 */
export function startScheduler() {
  if (config.scheduler !== 'internal') {
    log(`Унутрашњи распоред је искључен (SCHEDULER=${config.scheduler}). Послове позива спољни сервис.`);
    return [];
  }

  const options = { timezone: config.tz };
  const jobs = [
    cron.schedule(config.checkCron, () => safely('провера извора', () => checkSource({ log })), options),
  ];

  // Свакој најави одговара време из подешавања оброка, да распоред и
  // приказ у апликацији увек говоре исто.
  for (const meal of Object.values(MEALS)) {
    const [hour, minute] = meal.notifyAt.split(':').map(Number);
    jobs.push(cron.schedule(
      `${minute} ${hour} * * *`,
      () => safely(`најава: ${meal.label}`, () => notifyMeal(meal.key)),
      options,
    ));
  }

  const times = Object.values(MEALS).map((meal) => meal.notifyAt).join(', ');
  log(`Распоред активан у зони ${config.tz}: провера "${config.checkCron}", најаве ${times}.`);
  return jobs;
}
