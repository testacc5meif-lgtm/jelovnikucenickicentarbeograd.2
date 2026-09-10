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

test('вечерња најава циља сутрашњи доручак, остале данашњи оброк', () => {
  const veče = new Date('2026-09-03T20:30:00Z'); // 22:30 по београдском
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
  assert.equal(MEALS.dorucak.notifyAt, '22:30');
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

test('отргнуто слово са краја подножја се скида', async () => {
  // Испод табеле стоје потписи, а скен из њих отргне усамљено слово и
  // залепи га за крај напомене.
  const { parseFooter } = await import('../src/table.js');
  const line = (text, y) => text.split(' ').map((word, i) => ({
    x: i * 60, y, w: 50, h: 30, text: word, conf: 95, cx: i * 60 + 25, cy: y + 15,
  }));

  const prljavo = parseFooter([
    ...line('АЛЕРГО ИНФО: глутен, јаја, соја И', 100),
    ...line('НАПОМЕНА: МОЖЕ ДОЋИ ДО ИЗМЕНЕ ЈЕЛОВНИКА. И', 200),
  ]);
  assert.equal(prljavo.allergens, 'глутен, јаја, соја');
  assert.equal(prljavo.note, 'МОЖЕ ДОЋИ ДО ИЗМЕНЕ ЈЕЛОВНИКА.');

  // Чисто подножје се не сме окрњити.
  const cisto = parseFooter([
    ...line('АЛЕРГО ИНФО: глутен, јаја, млеко, риба, соја, конзерванси', 100),
    ...line('НАПОМЕНА: МОЖЕ ДОЋИ ДО ИЗМЕНЕ ЈЕЛОВНИКА.', 200),
  ]);
  assert.equal(cisto.allergens, 'глутен, јаја, млеко, риба, соја, конзерванси');
  assert.equal(cisto.note, 'МОЖЕ ДОЋИ ДО ИЗМЕНЕ ЈЕЛОВНИКА.');
});

test('поправка подножја мења већ уписан запис и сме да се понови', async () => {
  // Кад се обрада поправи, то важи тек за наредни јеловник. Оно што је
  // већ у бази мора да се поправи посебно, јер корисник види баш то.
  process.env.DB_PATH = './data/maintenance.db';
  const fresh = await import(`../src/db.js?t=${Date.now()}`);
  const { tidyStoredFooter } = await import(`../src/maintenance.js?t=${Date.now()}`);

  await fresh.insertSource({
    url: 'u', sha256: `x-${Date.now()}`, bytes: 1,
    periodFrom: '2026-09-01', periodTo: '2026-09-02',
    allergens: 'глутен, јаја, соја И',
    note: 'МОЖЕ ДОЋИ ДО ИЗМЕНЕ ЈЕЛОВНИКА. И',
    dayCount: 1,
  });

  const prvi = await tidyStoredFooter({ log: () => {} });
  assert.equal(prvi.changed, true);
  assert.equal(prvi.note, 'МОЖЕ ДОЋИ ДО ИЗМЕНЕ ЈЕЛОВНИКА.');
  assert.equal(prvi.allergens, 'глутен, јаја, соја');

  const drugi = await tidyStoredFooter({ log: () => {} });
  assert.equal(drugi.changed, false, 'поновно покретање не сме ништа да мења');
});

test('датум се не чита из кешираног одговора сервера', () => {
  // /api/meta стоји у кешу прегледача, па би апликација сутра и даље
  // мислила да је јуче. Датум и час се зато рачунају на самом уређају,
  // у зони установе.
  const app = fs.readFileSync('./public/app.js', 'utf8');
  assert.ok(!app.includes('state.meta.today'), 'датум не сме да долази из /api/meta');
  assert.match(app, /function nowThere\(\)/, 'мора да постоји рачунање датума у зони установе');
  assert.match(app, /timeZone: zone/, 'рачунање мора да поштује зону, не сат уређаја');
  assert.ok(!app.includes('new Date().getHours()'), 'час се не сме узимати са сата уређаја');
});

test('приказ тражи свеж податак мимо кеша одмах по отварању', () => {
  // Кеширан /api/meta умео је да остане заробљен данима, па су се виделе
  // старе вредности: прво време најаве, па отргнуто слово у напомени.
  const app = fs.readFileSync('./public/app.js', 'utf8');
  const sw = fs.readFileSync('./public/sw.js', 'utf8');
  assert.match(app, /refreshMeta\(\)/, 'мора да постоји освежавање после првог исцртавања');
  assert.match(app, /api\/meta\?svez=1/, 'освежавање мора да заобиђе кеш');
  assert.match(sw, /searchParams\.get\('svez'\) === '1'/, 'service worker мора да пропусти тај захтев на мрежу');
});

test('порука о обавештењима каже шта да се уради, за сваки уређај', async () => {
  // На iPhone-у сваки прегледач ради на Apple-овом мотору, али само Safari
  // сме да дода апликацију на почетни екран. Chrome тамо нема PushManager,
  // па је корисник добијао поруку да прегледач не подржава обавештења,
  // што је тачно али не каже шта даље.
  const src = fs.readFileSync('./public/app.js', 'utf8');
  const telo = src.slice(src.indexOf('const isStandalone ='), src.indexOf('function openSheet'));

  const proba = (ua, { standalone = false, push = true } = {}) => {
    const nav = { userAgent: ua, platform: /iPhone/.test(ua) ? 'iPhone' : 'Linux', maxTouchPoints: 5, standalone, serviceWorker: {} };
    const win = { navigator: nav, matchMedia: () => ({ matches: standalone }) };
    if (push) win.PushManager = function () {};
    const fn = new Function('navigator', 'window', 'state', `${telo}\n; return whyNotSubscribable();`);
    return fn(nav, win, { meta: { pushEnabled: true } });
  };

  const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

  assert.match(proba(`${IOS} CriOS/120.0`), /Safari/, 'Chrome на iPhone-у мора да упути на Safari');
  assert.match(proba(`${IOS} Version/17.0 Safari/604.1`), /почетни екран/, 'Safari мора да упути на додавање на почетни екран');
  assert.equal(proba(`${IOS} Version/17.0 Safari/604.1`, { standalone: true }), null, 'из инсталиране апликације претплата мора да буде могућа');
  assert.match(proba(`${IOS} Version/15.0 Safari/604.1`, { standalone: true, push: false }), /16\.4/, 'старији iOS мора да добије тачан разлог');
  assert.equal(proba('Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile'), null, 'на Android-у претплата мора да буде могућа');
});

test('звоно ради и пре него што подаци стигну', () => {
  // Render се буди и по двадесет секунди, а корисник за то време додирне
  // звоно. Читање оброка из празног стања бацало је грешку коју нико не
  // види, па је дугме деловало као да уопште не ради.
  const app = fs.readFileSync('./public/app.js', 'utf8');
  const sheet = app.slice(app.indexOf('function openSheet'), app.indexOf('async function saveSubscription'));

  assert.match(sheet, /if \(!state\.meta\)/, 'прозор мора да се отвори и без података');
  assert.ok(
    sheet.indexOf('if (!state.meta)') < sheet.indexOf('for (const meal of state.meta.meals)'),
    'провера празног стања мора да дође пре читања оброка',
  );
  assert.match(app, /catch \(error\) \{\s*el\('sheet'\)\.hidden = false;/, 'грешка при отварању мора да стигне до корисника');
});

test('оброк траје, није тренутак', async () => {
  // Апликација је у 18:40 писала да је вечера прошла, иако се служи до
  // 20:30. Свака ставка мора да има и време завршетка.
  const { MEALS } = await import('../src/config.js');

  const očekivano = {
    dorucak: ['06:30', '07:30'],
    rucak: ['11:30', '15:00'],
    vecera: ['18:30', '20:30'],
  };

  for (const [key, [start, end]] of Object.entries(očekivano)) {
    assert.equal(MEALS[key].startsAt, start, `${key} почиње у ${start}`);
    assert.equal(MEALS[key].endsAt, end, `${key} се служи до ${end}`);
    assert.ok(MEALS[key].endsAt > MEALS[key].startsAt, `${key}: крај мора да буде после почетка`);
  }

  // Најава мора да стигне пре него што служење почне.
  for (const meal of Object.values(MEALS)) {
    if (meal.targetDayOffset === 0) {
      assert.ok(meal.notifyAt < meal.startsAt, `${meal.key}: најава мора да претходи служењу`);
    }
  }
});

test('приказ разликује три стања оброка', () => {
  const app = fs.readFileSync('./public/app.js', 'utf8');
  assert.match(app, /function mealState/, 'мора да постоји рачунање стања оброка');
  assert.match(app, /'у току'/, 'мора да постоји стање док се оброк служи');
  assert.match(app, /endsAt/, 'стање мора да се рачуна и из времена завршетка');
});

test('приказ при отварању стаје на оброк који је у току', () => {
  const app = fs.readFileSync('./public/app.js', 'utf8');
  assert.match(app, /function focusOnMeal/, 'мора да постоји померање на оброк');
  assert.match(app, /sada\.date === state\.selected \? sada\.meal\.key : null/, 'циљ мора да буде оброк који је у току или следи');
  assert.match(app, /const vidiSe = /, 'померање мора да изостане ако се картица већ види');
});
