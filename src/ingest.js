import { discoverMenus, downloadPdf } from './scraper.js';
import { extractMenu, normalize } from './extract.js';
import { acceptMenu } from './validate.js';
import * as store from './db.js';

/** Исход последње провере извора, за преглед преко /health. */
let lastRun = { at: null, status: 'још није покренуто', problems: [] };

export function lastIngest() {
  return lastRun;
}

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
 *
 * PDF који је већ обрађен препознаје се по SHA-256 отиску и прескаче, па
 * поновно покретање ништа не кошта.
 *
 * Обрада која не прође проверу **не дира базу**. То је најважније правило
 * овде: ако установа промени распоред колона у PDF-у, обрада ће и даље
 * радити и вратити празан или поломљен јеловник, а он би прегазио
 * исправан. Отисак се тада намерно не памти, па се покушај понавља при
 * следећој провери и сам се поправи ако је квар био пролазан.
 */
export async function runIngest({ log = console.log } = {}) {
  const links = await discoverMenus();
  log(`Пронађено PDF линкова: ${links.length}`);

  const processed = [];
  const skipped = [];
  const rejected = [];

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
    const { menu, accepted, stats } = await extractMenu(bytes, { knownItems: await store.allItemTexts() });

    if (!accepted.ok) {
      rejected.push({ url: link.readable, problems: accepted.problems, stats: accepted.stats });
      log(`ОДБИЈЕНО, база није дирана: ${link.readable}`);
      for (const problem of accepted.problems) log(`  ${problem}`);
      continue;
    }

    await storeMenu({ url: link.url, sha256, bytes: bytes.length, menu });
    processed.push({ url: link.readable, days: menu.days.length, stats });
    log(`Уписано дана: ${menu.days.length} (${menu.periodFrom} - ${menu.periodTo}), речник ${stats.lexicon} речи`);
  }

  lastRun = {
    at: new Date().toISOString(),
    status: rejected.length > 0 ? 'одбијено' : 'у реду',
    processed: processed.length,
    skipped: skipped.length,
    problems: rejected.flatMap((entry) => entry.problems),
  };

  return { processed, skipped, rejected };
}

/** Уписује ручно припремљен JSON, за демо и за тестове без обраде PDF-а. */
export async function ingestFixture(raw, { url = 'fixture://', sha256 = `fixture-${Date.now()}` } = {}) {
  const menu = normalize(raw);
  const accepted = acceptMenu(menu);
  if (!accepted.ok) {
    throw new Error(`Јеловник није прошао проверу: ${accepted.problems.join('; ')}`);
  }
  await storeMenu({ url, sha256, bytes: 0, menu });
  return menu;
}
