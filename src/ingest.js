import { discoverMenus, downloadPdf } from './scraper.js';
import { extractMenu, normalize } from './extract.js';
import * as store from './db.js';

/** Уписује већ структуриран јеловник у базу. */
export async function storeMenu({ url, sha256, bytes, menu }) {
  const sourceId = await store.insertSource({
    url,
    sha256,
    bytes,
    periodFrom: menu.periodFrom,
    periodTo: menu.periodTo,
    allergens: menu.allergens,
    note: menu.note,
    dayCount: menu.days.length,
  });
  for (const day of menu.days) await store.upsertDay(sourceId, day);
  return sourceId;
}

/**
 * Проверава сајт, обрађује сваки нови PDF и уписује га у базу.
 * PDF који је већ обрађен препознаје се по SHA-256 отиску и прескаче,
 * па поновно покретање не троши ништа.
 */
export async function runIngest({ log = console.log } = {}) {
  const links = await discoverMenus();
  log(`Пронађено PDF линкова: ${links.length}`);

  const processed = [];
  const skipped = [];

  for (const link of links) {
    const { bytes, sha256 } = await downloadPdf(link.url);
    if (await store.findSourceByHash(sha256)) {
      skipped.push(link.readable);
      log(`Прескачем, већ обрађено: ${link.readable}`);
      continue;
    }

    log(`Обрађујем: ${link.readable} (${bytes.length} B)`);

    // Речник за исправку расте са сваким обрађеним јеловником, јер се
    // иста јела понављају из циклуса у циклус.
    const { menu, warnings, stats } = await extractMenu(bytes, { knownItems: await store.allItemTexts() });
    await storeMenu({ url: link.url, sha256, bytes: bytes.length, menu });

    processed.push({ url: link.readable, days: menu.days.length, warnings, stats });
    log(`Уписано дана: ${menu.days.length} (${menu.periodFrom} - ${menu.periodTo}), речник ${stats.lexicon} речи`);
    for (const warning of warnings) log(`  провери: ${warning}`);
  }

  return { processed, skipped };
}

/** Уписује ручно припремљен JSON, за демо и за тестове без API кључа. */
export async function ingestFixture(raw, { url = 'fixture://', sha256 = `fixture-${Date.now()}` } = {}) {
  const menu = normalize(raw);
  await storeMenu({ url, sha256, bytes: 0, menu });
  return menu;
}
