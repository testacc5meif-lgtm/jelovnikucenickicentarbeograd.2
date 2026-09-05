import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Тестови раде на свом SQLite фајлу и никад не додирују живу базу.
// Без овога би подешавања из .env одвела тестове на Supabase, па би
// падали кад год се тамо нешто промени.
process.env.DATABASE_URL = '';
process.env.DB_PATH = './data/test.db';

const { toCyrillic } = await import('../src/translit.js');
const { normalize } = await import('../src/extract.js');
const { POOLS, pickMessage } = await import('../src/messages.js');
const { today, shiftDate, weekdayOf } = await import('../src/dates.js');
const { findPdfLinks } = await import('../src/scraper.js');

test('пресловљавање латинице у ћирилицу', () => {
  assert.equal(toCyrillic('pileća čorba'), 'пилећа чорба');
  assert.equal(toCyrillic('pasulj prebranac, prženi filet'), 'пасуљ пребранац, пржени филет');
  assert.equal(toCyrillic('Njegoš'), 'Његош');
  assert.equal(toCyrillic('džem'), 'џем');
});

test('текст који је већ на ћирилици остаје нетакнут', () => {
  const text = 'посл.колач (мафин)';
  assert.equal(toCyrillic(text), text);
});

test('нормализација чисти цртице и вишак размака, а не дели по зарезима', () => {
  const result = normalize({
    period_from: '2026-09-01',
    period_to: '2026-09-01',
    allergens: '',
    note: '',
    days: [{
      date: '2026-09-01',
      weekday: 'Уторак',
      dorucak: ['-чај,  млеко, јогурт', '  барене виршле, сенф '],
      rucak: ['печена пилетина, динстани пиринач, парадајз сос'],
      vecera: [''],
    }],
  });

  const day = result.days[0];
  assert.equal(day.weekday, 'уторак');
  assert.deepEqual(day.dorucak, ['чај, млеко, јогурт', 'барене виршле, сенф']);
  assert.equal(day.rucak.length, 1, 'сложено јело остаје једна ставка');
  assert.deepEqual(day.vecera, []);
});

test('нормализација одбацује дане без исправног датума и сортира хронолошки', () => {
  const result = normalize({
    period_from: 'x',
    period_to: 'y',
    allergens: '',
    note: '',
    days: [
      { date: '2026-09-05', weekday: 'субота', dorucak: ['чај'], rucak: [], vecera: [] },
      { date: '05.09.2026', weekday: 'субота', dorucak: ['чај'], rucak: [], vecera: [] },
      { date: '2026-09-02', weekday: 'среда', dorucak: ['чај'], rucak: [], vecera: [] },
    ],
  });

  assert.deepEqual(result.days.map((day) => day.date), ['2026-09-02', '2026-09-05']);
  assert.equal(result.periodFrom, '2026-09-02');
  assert.equal(result.periodTo, '2026-09-05');
});

test('ниједно обавештење не открива садржај менија', () => {
  const menu = JSON.parse(fs.readFileSync('./fixtures/jelovnik-2026-09-I.json', 'utf8'));
  const dishes = new Set();
  for (const day of menu.days) {
    for (const meal of ['dorucak', 'rucak', 'vecera']) {
      for (const item of day[meal]) {
        for (const word of item.split(/[^\p{L}]+/u)) {
          if (word.length >= 4) dishes.add(word.toLowerCase());
        }
      }
    }
  }

  // Поређење иде по целим речима: "Питаш" није помен јела "пита".
  for (const [meal, pool] of Object.entries(POOLS)) {
    for (const message of pool) {
      const words = `${message.title} ${message.body}`.toLowerCase().split(/[^\p{L}]+/u);
      for (const word of words) {
        assert.ok(!dishes.has(word), `порука за ${meal} помиње јело "${word}"`);
      }
    }
  }
});

test('избор поруке је поновљив и мења се из дана у дан', () => {
  assert.equal(pickMessage('rucak', '2026-09-03').body, pickMessage('rucak', '2026-09-03').body);

  // Пореди се цела порука, не само наслов. Наслови се понављају зато што
  // морају да стану у један ред, па разноликост носи текст испод њега.
  const week = ['01', '02', '03', '04', '05', '06', '07']
    .map((day) => {
      const message = pickMessage('rucak', `2026-09-${day}`);
      return `${message.title}|${message.body}`;
    });
  assert.equal(new Set(week).size, 7, 'кроз недељу дана не понавља се иста порука');
});

test('датумске функције раде у зони установе', () => {
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(shiftDate('2026-09-30', 1), '2026-10-01');
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(weekdayOf('2026-09-01'), 'уторак');
  assert.equal(weekdayOf('2026-09-06'), 'недеља');
});

test('проналажење PDF линкова издваја јеловнике и решава релативне путање', () => {
  const html = `
    <a href="/wp-content/uploads/2026/08/Jelovnik-septembar.pdf">Јеловник</a>
    <a href="https://example.rs/pravilnik.pdf">Правилник</a>
    <a href="/wp-content/uploads/2026/08/Jelovnik-septembar.pdf">исти линк</a>
  `;
  const links = findPdfLinks(html, 'https://www.ucenickicentar-bg.rs/sluzba-ishrane/');
  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://www.ucenickicentar-bg.rs/wp-content/uploads/2026/08/Jelovnik-septembar.pdf');
});

test('када нема ниједног јеловника, враћају се сви PDF линкови', () => {
  const links = findPdfLinks('<a href="https://example.rs/a.pdf">A</a>', 'https://example.rs/');
  assert.equal(links.length, 1);
});

/* ---------- Реконструкција табеле и речник ---------- */

const { itemsFrom, assembleDays } = await import('../src/table.js');
const { buildLexicon, correctItem, splitMerged } = await import('../src/dictionary.js');

const asLine = (text, top = 0, conf = 95) => ({
  text, top, left: 0, cy: top, words: [{ x: 0, y: top, w: 10, h: 30, text, conf }],
});

test('ред без цртице наставља претходну ставку', () => {
  const items = itemsFrom([
    asLine('-печена пилетина, динстани', 0),
    asLine('пиринач, парадајз сос', 30),
    asLine('-салата (купус, краставац)', 60),
  ]);
  assert.deepEqual(items, [
    'печена пилетина, динстани пиринач, парадајз сос',
    'салата (купус, краставац)',
  ]);
});

test('датум који скен није прочитао следи из редоследа дана', () => {
  const days = assembleDays([[
    { date: '2026-09-01' }, { date: null }, { date: '2026-09-03' },
  ]]);
  assert.equal(days[1].date, '2026-09-02');
  assert.equal(days[1].dateGuessed, true);
});

test('датум који одступа од низа означава се за проверу', () => {
  const days = assembleDays([[{ date: '2026-09-01' }, { date: '2026-09-05' }]]);
  assert.equal(days[1].dateConflict, '2026-09-02');
});

test('речник исправља реч прочитану латиницом', () => {
  const lexicon = buildLexicon(['чај, млеко, јогурт', 'салата (купус)', 'проја']);
  assert.equal(correctItem('canara (купус)', lexicon), 'салата (купус)');
  assert.equal(correctItem('npoja', lexicon), 'проја');
});

test('речник не дира непознату ћириличну реч', () => {
  // Речник је намерно непотпун, нова јела се стално појављују. Замена
  // непознате ћириличне речи сличном познатом више квари него што поправља.
  const lexicon = buildLexicon(['сок', 'сос']);
  assert.equal(correctItem('сосу', lexicon), 'сосу');
  assert.equal(correctItem('сомун', lexicon), 'сомун');
});

test('слепљене ставке се раздвајају само кад су оба дела позната', () => {
  const lexicon = buildLexicon(['поврће и воће', 'туњевина', 'шпагете са туњевином']);
  assert.deepEqual(
    splitMerged(['поврће и воће туњевина'], lexicon),
    ['поврће и воће', 'туњевина'],
  );
  assert.deepEqual(
    splitMerged(['шпагете са туњевином'], lexicon),
    ['шпагете са туњевином'],
  );
});

test('познато јело у реду без цртице почиње нову ставку', () => {
  // Скен је изгубио цртицу испред "туњевина", али речник зна то јело.
  const lexicon = buildLexicon(['поврће и воће', 'туњевина']);
  const items = itemsFrom([
    asLine('-поврће и воће', 0),
    asLine('туњевина', 30),
  ], lexicon);
  assert.deepEqual(items, ['поврће и воће', 'туњевина']);
});

test('зарез на крају реда чува преломљену ставку у целини', () => {
  // "фета сир" јесте познато јело, али претходни ред се завршава зарезом,
  // па реченица тече даље и ставка остаје једна.
  const lexicon = buildLexicon(['фета сир', 'кајгана']);
  const items = itemsFrom([
    asLine('-кајгана са крањском кобасицом,', 0),
    asLine('фета сир', 30),
  ], lexicon);
  assert.deepEqual(items, ['кајгана са крањском кобасицом, фета сир']);
});

test('ред слабог читања се не лепи за претходну ставку', () => {
  // Линије табеле Tesseract прочита као речи ниске поузданости.
  const items = itemsFrom([
    asLine('-воће (крушка)', 0, 95),
    asLine('не Пева ни', 30, 12),
  ]);
  assert.deepEqual(items, ['воће (крушка)']);
});

/* ---------- Периодични послови ---------- */

const { targetDate } = await import('../src/jobs.js');
const { MEALS } = await import('../src/config.js');

test('најава у 22:00 циља сутрашњи доручак, остале данашњи оброк', () => {
  const veče = new Date('2026-09-03T20:00:00Z'); // 22:00 по београдском
  assert.equal(targetDate('dorucak', veče), '2026-09-04');

  const podne = new Date('2026-09-04T08:30:00Z');
  assert.equal(targetDate('rucak', podne), '2026-09-04');
  assert.equal(targetDate('vecera', podne), '2026-09-04');
});

test('најава доручка прелази у наредни месец', () => {
  assert.equal(targetDate('dorucak', new Date('2026-09-30T20:00:00Z')), '2026-10-01');
});

test('распоред најава прати времена из подешавања оброка', () => {
  // Ако се време оброка промени, распоред и приказ у апликацији морају
  // да се помере заједно, јер обоје читају исти извор.
  assert.equal(MEALS.dorucak.notifyAt, '22:00');
  assert.equal(MEALS.rucak.notifyAt, '10:30');
  assert.equal(MEALS.vecera.notifyAt, '17:30');
  for (const meal of Object.values(MEALS)) {
    assert.match(meal.notifyAt, /^\d{2}:\d{2}$/);
    assert.ok(meal.accusative, `оброку ${meal.key} недостаје облик за акузатив`);
  }
});

test('дан у недељи се рачуна из датума, не чита са скена', () => {
  // Скен реч поред датума често прочита погрешно, а цифре готово никад.
  const result = normalize({
    period_from: '2026-09-01',
    period_to: '2026-09-06',
    allergens: '',
    note: '',
    days: [
      { date: '2026-09-01', weekday: 'yropak', dorucak: ['чај'], rucak: [], vecera: [] },
      { date: '2026-09-06', dorucak: ['чај'], rucak: [], vecera: [] },
    ],
  });
  assert.equal(result.days[0].weekday, 'уторак');
  assert.equal(result.days[1].weekday, 'недеља');
});

test('наслов обавештења почиње називом оброка и стаје у један ред', async () => {
  // Android наслов скраћује на један ред. Кад је оброк прва реч, чак и
  // пресечено „Ручак…" каже све што треба.
  const { TITLE_LIMIT } = await import('../src/messages.js');
  const first = { dorucak: 'Доручак', rucak: 'Ручак', vecera: 'Вечера' };

  for (const [meal, pool] of Object.entries(POOLS)) {
    for (const message of pool) {
      assert.ok(
        message.title.startsWith(first[meal]),
        `наслов за ${meal} не почиње речју "${first[meal]}": ${message.title}`,
      );
      assert.ok(
        message.title.length <= TITLE_LIMIT,
        `наслов је дуг ${message.title.length} знакова, највише ${TITLE_LIMIT}: ${message.title}`,
      );
    }
  }
});

/* ---------- Капија пред упис у базу ---------- */

const { acceptMenu } = await import('../src/validate.js');

const validMenu = () => JSON.parse(fs.readFileSync('./fixtures/jelovnik-2026-09-I.json', 'utf8'));

test('исправан јеловник пролази проверу', () => {
  const menu = normalize(validMenu());
  const verdict = acceptMenu(menu);
  assert.equal(verdict.ok, true, `одбијено без разлога: ${verdict.problems.join('; ')}`);
  assert.equal(verdict.stats.days, 15);
});

test('празан оброк зауставља упис', () => {
  // Најјаснији знак да подела на колоне више не ваља.
  const raw = validMenu();
  raw.days[3].rucak = [];
  const verdict = acceptMenu(normalize(raw));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes('празан оброк')), verdict.problems.join('; '));
});

test('све колоне слепљене у једну зауставља упис', () => {
  // Ако распоред колона у PDF-у падне, све ставке заврше у првој колони.
  const raw = validMenu();
  for (const day of raw.days) {
    day.dorucak = [...day.dorucak, ...day.rucak, ...day.vecera];
    day.rucak = [];
    day.vecera = [];
  }
  assert.equal(acceptMenu(normalize(raw)).ok, false);
});

test('премало прочитаних дана зауставља упис', () => {
  const raw = validMenu();
  raw.days = raw.days.slice(0, 3);
  const verdict = acceptMenu(normalize(raw));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes('дана')), verdict.problems.join('; '));
});

test('несклад датума зауставља упис', () => {
  const menu = normalize(validMenu());
  menu.days[5].dateConflict = '2026-09-99';
  const verdict = acceptMenu(menu);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes('датум')), verdict.problems.join('; '));
});

test('потпуно празан резултат зауставља упис', () => {
  assert.equal(acceptMenu({ days: [] }).ok, false);
  assert.equal(acceptMenu(null).ok, false);
});

test('пробно слање не улази у дневник и не чепи прави термин', async () => {
  // Проба послата у поноћ уписивала се у дневник, па је редовна најава у
  // 10:30 видела да је за тај дан већ послато и прескочила. Тако је и
  // пропуштена најава за ручак 5. септембра.
  const source = String(fs.readFileSync('./src/push.js', 'utf8'));
  assert.match(
    source,
    /if \(!force\) await store\.logSend\(/,
    'пробно слање не сме да уписује у дневник слања',
  );
});
