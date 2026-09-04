// Обрада јеловника из PDF-а, без иједног плаћеног сервиса.
//
// Ток: PDF -> слике страна -> Tesseract -> реконструкција табеле из
// координата -> исправка помоћу речника већ виђених јела -> провера.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPageImages, cleanup } from './pdf-pages.js';
import { readWords } from './ocr.js';
import { parsePage, parseFooter, assembleDays } from './table.js';
import { buildLexicon, correctDay } from './dictionary.js';
import { toCyrillic } from './translit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(here, '..', 'fixtures', 'jelovnik-2026-09-I.json');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MEALS = ['dorucak', 'rucak', 'vecera'];

/** Ставке из ручног преписа, почетни речник кад база је још празна. */
export function seedItems() {
  try {
    const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
    return seed.days.flatMap((day) => MEALS.flatMap((meal) => day[meal] || []));
  } catch {
    return [];
  }
}

function cleanItem(text) {
  return toCyrillic(
    String(text)
      .replace(/\s+/g, ' ')
      .replace(/^[-–—•\s]+/, '')
      .trim(),
  );
}

function cleanList(list) {
  const cleaned = (Array.isArray(list) ? list : []).map(cleanItem).filter(Boolean);
  return cleaned.filter((item, index) => item !== cleaned[index - 1]);
}

/** Провера и чишћење пре уписа у базу. */
export function normalize(parsed) {
  const days = (parsed.days || [])
    .filter((day) => ISO_DATE.test(day.date))
    .map((day) => ({
      date: day.date,
      weekday: toCyrillic(String(day.weekday || '').trim().toLowerCase()),
      dorucak: cleanList(day.dorucak),
      rucak: cleanList(day.rucak),
      vecera: cleanList(day.vecera),
    }))
    .filter((day) => day.dorucak.length + day.rucak.length + day.vecera.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const seen = new Set();
  const unique = days.filter((day) => !seen.has(day.date) && seen.add(day.date));

  return {
    periodFrom: ISO_DATE.test(parsed.period_from) ? parsed.period_from : unique[0]?.date ?? null,
    periodTo: ISO_DATE.test(parsed.period_to) ? parsed.period_to : unique.at(-1)?.date ?? null,
    allergens: toCyrillic(String(parsed.allergens || '').trim()),
    note: toCyrillic(String(parsed.note || '').trim()),
    days: unique,
  };
}

/**
 * Заставице за ручну проверу. Обрада никад не пуца тихо: ако дан изгледа
 * необично, означава се, па се погрешан јеловник не покаже као тачан.
 */
function inspect(days) {
  const warnings = [];

  for (const day of days) {
    if (day.dateConflict) {
      warnings.push(`${day.date}: датум одступа од низа, редослед каже ${day.dateConflict}`);
    }
    for (const meal of MEALS) {
      const count = (day[meal] || []).length;
      if (count === 0) warnings.push(`${day.date}: ${meal} је празан`);
      if (count > 14) warnings.push(`${day.date}: ${meal} има ${count} ставки, необично много`);
    }
  }

  return warnings;
}

/**
 * Обрађује PDF и враћа структуриран јеловник.
 *
 * @param {Buffer} pdfBytes
 * @param {object} options
 *   `knownItems` ставке из базе, које проширују речник за исправку
 */
export async function extractMenu(pdfBytes, { knownItems = [] } = {}) {
  const { files, dir, method } = await toPageImages(pdfBytes);

  try {
    // Речник се гради пре читања, јер помаже већ при подели на ставке.
    const lexicon = buildLexicon([...seedItems(), ...knownItems]);

    const pages = [];
    let lastWords = [];
    for (const file of files) {
      lastWords = await readWords(file);
      pages.push(parsePage(lastWords, lexicon));
    }

    // Алерго подаци и напомена стоје на последњој страни, испод табеле.
    const footer = parseFooter(lastWords);
    const days = assembleDays(pages);
    const corrected = days.map((day) => correctDay(day, lexicon));

    const menu = normalize({
      period_from: corrected[0]?.date,
      period_to: corrected.at(-1)?.date,
      allergens: footer.allergens,
      note: footer.note,
      days: corrected,
    });

    return {
      menu,
      warnings: inspect(corrected),
      stats: { pages: files.length, method, lexicon: lexicon.words.size },
    };
  } finally {
    cleanup(dir);
  }
}
