#!/usr/bin/env node
// Једнократна обрада. Употреба:
//   node scripts/ingest-once.js                      - провери сајт и обради нове PDF-ове
//   node scripts/ingest-once.js --file put/do.pdf    - обради локални PDF
//   node scripts/ingest-once.js --fixture path.json  - упиши припремљен JSON (без API кључа)
import fs from 'node:fs';
import crypto from 'node:crypto';
import { runIngest, storeMenu, ingestFixture } from '../src/ingest.js';
import { extractMenu } from '../src/extract.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};

try {
  const fixturePath = flag('--fixture');
  const filePath = flag('--file');

  if (fixturePath) {
    const menu = await ingestFixture(JSON.parse(fs.readFileSync(fixturePath, 'utf8')), { url: `file://${fixturePath}` });
    console.log(`Уписано дана: ${menu.days.length} (${menu.periodFrom} - ${menu.periodTo})`);
  } else if (filePath) {
    const bytes = fs.readFileSync(filePath);
    const { menu, warnings, stats } = await extractMenu(bytes);
    await storeMenu({
      url: `file://${filePath}`,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      menu,
    });
    console.log(`Уписано дана: ${menu.days.length} (${menu.periodFrom} - ${menu.periodTo})`);
    console.log(`Стране: ${stats.pages} (${stats.method}), речник: ${stats.lexicon} речи`);
    for (const warning of warnings) console.log(`  провери: ${warning}`);
  } else {
    const result = await runIngest();
    console.log(`Обрађено: ${result.processed.length}, прескочено: ${result.skipped.length}`);
  }
  process.exit(0);
} catch (error) {
  console.error('Грешка:', error.message);
  process.exit(1);
}
