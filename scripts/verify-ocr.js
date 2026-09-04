#!/usr/bin/env node
// Мери тачност обраде у односу на ручни препис.
//
//   node scripts/verify-ocr.js                      сa сајта, поштено мерење
//   node scripts/verify-ocr.js --pdf lokalni.pdf    локални фајл
//   node scripts/verify-ocr.js --holdout 0          без речника, сирова тачност
//
// Речник за исправку у стварном раду долази из ранијих јеловника, не из
// оног који се управо обрађује. Зато се овде за речник узима само првих
// N дана еталона, а мери се на осталим данима. Тако број није улепшан.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPageImages, cleanup } from '../src/pdf-pages.js';
import { readWords, checkOcr } from '../src/ocr.js';
import { parsePage, assembleDays } from '../src/table.js';
import { buildLexicon, correctDay } from '../src/dictionary.js';
import { discoverMenus, downloadPdf } from '../src/scraper.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MEALS = ['dorucak', 'rucak', 'vecera'];

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const holdout = Number(flag('--holdout', 7));
const fixturePath = flag('--fixture', path.join(here, '..', 'fixtures', 'jelovnik-2026-09-I.json'));
const pdfPath = flag('--pdf', null);

const ready = await checkOcr();
if (!ready.ok) {
  console.error(`OCR није спреман: ${ready.reason}`);
  process.exit(1);
}
console.log(ready.version);

const bytes = pdfPath
  ? fs.readFileSync(pdfPath)
  : (await downloadPdf((await discoverMenus())[0].url)).bytes;

const truth = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).days;

// Речник види само првих N дана, оцењује се на осталима.
const lexiconItems = truth.slice(0, holdout).flatMap((day) => MEALS.flatMap((meal) => day[meal]));
const lexicon = buildLexicon(lexiconItems);
const scored = truth.slice(holdout);

const { files, dir, method } = await toPageImages(bytes);
let days;
try {
  const pages = [];
  for (const file of files) pages.push(parsePage(await readWords(file)));
  days = assembleDays(pages).map((day) => correctDay(day, lexicon));
} finally {
  cleanup(dir);
}

const byDate = new Map(days.map((day) => [day.date, day]));

let total = 0;
let correct = 0;
const misses = [];

for (const day of scored) {
  const got = byDate.get(day.date) || {};
  for (const meal of MEALS) {
    const have = new Set(got[meal] || []);
    for (const item of day[meal]) {
      total += 1;
      if (have.has(item)) correct += 1;
      else misses.push(`${day.date} ${meal}: ${item}`);
    }
  }
}

const share = total ? (correct / total) * 100 : 0;
console.log(`\nСтране: ${files.length} (${method}), речник: ${lexicon.words.size} речи из првих ${holdout} дана`);
console.log(`Оцењено дана: ${scored.length}`);
console.log(`Ставки: ${total} | тачних: ${correct} (${share.toFixed(1)}%) | промашених: ${misses.length}\n`);
for (const miss of misses) console.log(`  ${miss}`);

process.exit(misses.length === 0 ? 0 : 1);
