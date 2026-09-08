// Поправке над подацима који су већ у бази.
//
// Кад се обрада поправи, то важи тек за наредни јеловник. Оно што је већ
// уписано остаје какво је било, а корисник на екрану види баш то. Зато
// поправка мора да стигне и до постојећег записа.
//
// Све овде мора да буде безопасно за поновно покретање: изврши се при
// сваком подизању, а мења само оно што се стварно разликује.

import { trimTail } from './table.js';
import * as store from './db.js';

/**
 * Скида отргнуто слово са краја алерго података и напомене.
 *
 * Скен из потписа испод табеле понекад отргне усамљено слово и залепи га
 * за крај подножја, па је напомена гласила "...ДО ИЗМЕНЕ ЈЕЛОВНИКА. И".
 */
export async function tidyStoredFooter({ log = console.log } = {}) {
  const source = await store.latestSource();
  if (!source) return { changed: false, reason: 'нема ниједног извора' };

  const allergens = trimTail(String(source.allergens ?? ''));
  const note = trimTail(String(source.note ?? ''));

  if (allergens === source.allergens && note === source.note) {
    return { changed: false, reason: 'подножје је већ чисто' };
  }

  await store.updateSourceFooter(source.id, { allergens, note });
  log(`Подножје исправљено: ${JSON.stringify(source.note)} -> ${JSON.stringify(note)}`);
  return { changed: true, allergens, note };
}
