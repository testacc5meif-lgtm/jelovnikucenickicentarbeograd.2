#!/usr/bin/env node
// Мери тачност обраде у односу на ручно преписан јеловник.
//
//   node scripts/verify-ocr.js                          са сајта, актуелни јеловник
//   node scripts/verify-ocr.js --pdf lokalni.pdf        локални фајл
//   node scripts/verify-ocr.js --fixture put/do.json    други еталон
//
// Мери прави ток, онај који се пушта у рад, дакле `extractMenu` у целости,
// заједно са речником за исправку. Речник долази из ручног преписа ранијег
// циклуса, не из оног који се оцењује, па број није улепшан.
//
// Еталон је преписан са слика скена и носи оно што у документу пише,
// укључујући и његове штампарске грешке. Зато измена коју речник уради над
// грешком самог документа ("кромпр" у "кромпир") овде испадне као промашај,
// иако је за читаоца поправка. Излаз их раздваја.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMenu } from '../src/extract.js';
import { checkOcr } from '../src/ocr.js';
import { discoverMenus, downloadPdf } from '../src/scraper.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MEALS = ['dorucak', 'rucak', 'vecera'];

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const fixturePath = flag('--fixture', path.join(here, '..', 'fixtures', 'jelovnik-2026-10-I.json'));
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

const truth = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const { menu, accepted, stats } = await extractMenu(bytes, { knownItems: [] });
const got = new Map(menu.days.map((day) => [day.date, day]));

let total = 0;
let correct = 0;
const misses = [];

for (const day of truth.days) {
  const mine = got.get(day.date);
  for (const meal of MEALS) {
    for (const item of day[meal]) {
      total += 1;
      if (mine && (mine[meal] || []).includes(item)) correct += 1;
      else misses.push({ date: day.date, meal, item, mine });
    }
  }
}

/**
 * Разлика између ставке у документу и оне коју је обрада дала.
 *
 * Враћа `{ other, letters }`, где `letters` каже да ли се разликује слово
 * или знак интерпункције. То двоје није исто: слово мења речник, намерно,
 * кад документ има штампарску грешку ("кромпр" у "кромпир"). Изгубљена
 * запета није поправка него ситан квар обраде, и мора да се броји као квар.
 */
const compare = (item, list = []) => {
  for (const other of list) {
    if (Math.abs(other.length - item.length) > 1) continue;
    const a = item.toLowerCase();
    const b = other.toLowerCase();
    const changed = [];
    let ok = true;

    for (let i = 0, j = 0; i < a.length || j < b.length; i += 1, j += 1) {
      if (a[i] === b[j]) continue;
      changed.push(a[i], b[j]);
      if (changed.length > 2) { ok = false; break; }
      if (a.length > b.length) j -= 1;
      else if (b.length > a.length) i -= 1;
    }

    if (!ok) continue;
    const letters = changed.filter(Boolean).every((ch) => /\p{L}/u.test(ch));
    return { other, letters };
  }
  return null;
};

const graded = misses.map((miss) => ({ ...miss, diff: compare(miss.item, miss.mine?.[miss.meal]) }));
const fixed = graded.filter((miss) => miss.diff?.letters);
const broken = graded.filter((miss) => !miss.diff?.letters);
const share = total ? (correct / total) * 100 : 0;
const withFixes = total ? ((correct + fixed.length) / total) * 100 : 0;

console.log(`\nСтране: ${stats.pages} (${stats.method}), речник: ${stats.lexicon} речи`);
console.log(`Дана: ${menu.days.length} од ${truth.days.length}, период ${menu.periodFrom} - ${menu.periodTo}`);
console.log(`Проверу пред упис пролази: ${accepted.ok ? 'да' : 'НЕ'}`);
console.log(`\nСтавки: ${total} | исто као у документу: ${correct} (${share.toFixed(1)}%)`);
console.log(`Речник поправио грешку документа: ${fixed.length} (са тим: ${withFixes.toFixed(1)}%)`);
console.log(`Стварно погрешно: ${broken.length}\n`);

for (const miss of fixed) {
  console.log(`  поправљено  ${miss.date} ${miss.meal}`);
  console.log(`    документ: ${miss.item}`);
  console.log(`    обрада:   ${miss.diff.other}`);
}
for (const miss of broken) {
  console.log(`  ПОГРЕШНО    ${miss.date} ${miss.meal}`);
  console.log(`    документ: ${miss.item}`);
  console.log(`    обрада:   ${(miss.mine?.[miss.meal] ?? []).join(' | ') || '(дана нема)'}`);
}

process.exit(broken.length === 0 ? 0 : 1);
