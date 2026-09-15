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
  // Пресудно је да ли је апликација на почетном екрану, не који ју је
  // прегледач тамо ставио. Провера је раније тражила Safari, па је
  // апликација додата преко Chrome-а на iPhone-у добијала поруку да мора
  // Safari, а дугме Сачувај остајало угашено. Пријављено са уређаја:
  // дугме се притисне и ништа се не деси, иако обавештења ту раде.
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

  // Док апликација није на почетном екрану, порука мора да каже како се
  // тамо ставља, а не да упућује на други прегледач.
  for (const ua of [`${IOS} CriOS/120.0`, `${IOS} Version/17.0 Safari/604.1`]) {
    const poruka = proba(ua);
    assert.match(poruka, /почетни екран/, 'порука мора да упути на додавање на почетни екран');
    assert.ok(!/Safari/.test(poruka), 'порука не сме да тражи баш Safari');
  }

  // Инсталирана апликација ради без обзира на то одакле је додата.
  for (const ua of [`${IOS} Version/17.0 Safari/604.1`, `${IOS} CriOS/120.0`]) {
    assert.equal(proba(ua, { standalone: true }), null, 'из инсталиране апликације претплата мора да буде могућа');
  }

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

test('субота и недеља имају своју сатницу', async () => {
  const { SCHEDULE } = await import('../src/config.js');
  const { mealTimes, dayKind } = await import('../src/dates.js');

  assert.equal(dayKind('2026-09-11'), 'radni');
  assert.equal(dayKind('2026-09-12'), 'subota');
  assert.equal(dayKind('2026-09-13'), 'nedelja');

  // Доручак викендом креће сат касније и краће траје.
  for (const dan of ['subota', 'nedelja']) {
    assert.deepEqual(SCHEDULE[dan].dorucak, { startsAt: '07:30', endsAt: '08:15' });
  }
  assert.deepEqual(SCHEDULE.subota.rucak, { startsAt: '12:00', endsAt: '14:00' });
  assert.deepEqual(SCHEDULE.nedelja.rucak, { startsAt: '12:00', endsAt: '13:00' });

  // Викендом се вечера не служи, добија се као ланч пакет на ручку.
  assert.equal(SCHEDULE.subota.vecera, null);
  assert.equal(SCHEDULE.nedelja.vecera, null);
  assert.equal(mealTimes('vecera', '2026-09-12'), null);
  assert.equal(mealTimes('vecera', '2026-09-13'), null);

  // Радним данима важи оно што стоји уз сам оброк.
  const { MEALS } = await import('../src/config.js');
  for (const key of Object.keys(MEALS)) {
    const times = mealTimes(key, '2026-09-11');
    assert.equal(times.startsAt, MEALS[key].startsAt, `${key}: радни дан мора да прати оброк`);
    assert.equal(times.endsAt, MEALS[key].endsAt, `${key}: радни дан мора да прати оброк`);
  }

  // Свака сатница мора да се заврши после почетка.
  for (const dan of Object.values(SCHEDULE)) {
    for (const [key, times] of Object.entries(dan)) {
      if (times) assert.ok(times.endsAt > times.startsAt, `${key}: крај мора да буде после почетка`);
    }
  }
});

test('викендом нема најаве за вечеру', async () => {
  // Ланч пакет се добија на ручку, па би подсетник у пола шест увече звао
  // на оброк кога нема. Најава пада на самој сатници, пре него што уопште
  // погледа да ли мени за тај дан постоји.
  const { notifyMeal } = await import('../src/jobs.js');

  for (const dan of ['2026-09-12', '2026-09-13']) {
    const ishod = await notifyMeal('vecera', { date: dan, force: true });
    assert.match(ishod.skipped || '', /не служи по сатници/, `${dan}: вечера не сме да се најави`);
  }

  // Радним данима иде као и до сада.
  const radni = await notifyMeal('vecera', { date: '2026-09-11', force: true });
  assert.ok(!/не служи по сатници/.test(radni.skipped || ''), 'радним данима најава мора да остане');
});

test('приказ оброка чита сатницу тог дана, не оног уз оброк', () => {
  const app = fs.readFileSync('./public/app.js', 'utf8');
  assert.match(app, /function timesFor/, 'мора да постоји читање сатнице за задати дан');
  assert.ok(
    !/meal\.startsAt\}–\$\{meal\.endsAt/.test(app),
    'заглавље картице не сме да пише времена уз сам оброк',
  );
  // Оброк без сатнице се прескаче кад се рачуна шта следи, иначе би
  // апликација викендом најављивала вечеру у 18:30.
  const deo = app.slice(app.indexOf('function whatsOn'), app.indexOf('function mealState'));
  assert.match(deo, /if \(!times\) continue/, 'оброк без сатнице не улази у рачун шта следи');
});

test('пропуштена најава се надокнађује чим јеловник стигне', async () => {
  // Нови јеловник никад не изађе тачно у поноћ. Док га нема, свака најава
  // за те дане се прескаче, а прескочена се не понавља сама. Чим уђе у
  // базу, надокнађује се оно што је пропало, али само оно што још има
  // смисла: оброк који је прошао се не најављује, ручак и вечера чекају
  // свој термин, а ноћу се не шаље ништа.
  const { catchUpNotifications } = await import('../src/jobs.js');
  const store = await import('../src/db.js');
  const { ingestFixture } = await import('../src/ingest.js');
  await store.ready;
  if (!(await store.hasMenuFor('2026-09-10'))) {
    await ingestFixture(JSON.parse(fs.readFileSync('./fixtures/jelovnik-2026-09-I.json', 'utf8')));
  }

  // Београдско време иде два сата испред UTC-а у септембру.
  const uSat = (h, m = 0) => new Date(Date.UTC(2026, 8, 10, h - 2, m));
  const pokusaji = async (now) => {
    const zapis = [];
    await catchUpNotifications({ now, log: (line) => zapis.push(line) });
    return zapis.map((line) => line.match(/надокнада најаве: (\S+) за (\S+):/)).filter(Boolean)
      .map(([, obrok, dan]) => `${obrok} ${dan}`);
  };

  // У једанаест је ручак пропустио свој термин у 10:30, а још се служи.
  assert.deepEqual(await pokusaji(uSat(11)), ['Ручак 2026-09-10']);

  // У пола седам ујутру доручак се служи, а његова синоћна најава је пала.
  assert.deepEqual(await pokusaji(uSat(6, 45)), ['Доручак 2026-09-10']);

  // У два по поноћи се не буди нико.
  assert.deepEqual(await pokusaji(uSat(2)), []);

  // У једанаест увече на реду је сутрашњи доручак, данашњи је давно прошао.
  assert.deepEqual(await pokusaji(uSat(23)), ['Доручак 2026-09-11']);

  // Суботом вечере нема, па нема ни шта да се надокнади.
  const subota = new Date(Date.UTC(2026, 8, 12, 17, 0)); // 19:00 по београдском
  assert.deepEqual(await pokusaji(subota), []);
});

test('сервер враћа шта је за претплату упамћено', async () => {
  // Приказ је до сада читао само оно што стоји у прегледачу, па је човек
  // коме обавештења стижу видео искључено стање, као да ништа није
  // сачувано. Сада може да пита сервер.
  const store = await import('../src/db.js');
  await store.ready;

  const endpoint = 'https://proba.example/претплата-за-тест';
  await store.saveSubscription(
    { endpoint, keys: { p256dh: 'kljuc', auth: 'tajna' } },
    { dorucak: true, rucak: false, vecera: true },
  );

  const red = await store.subscriptionByEndpoint(endpoint);
  assert.ok(red, 'претплата мора да се нађе по адреси');
  assert.ok(red.dorucak, 'доручак је био укључен');
  assert.ok(!red.rucak, 'ручак је био искључен');
  assert.ok(red.vecera, 'вечера је била укључена');

  await store.deleteSubscription(endpoint);
  assert.equal(await store.subscriptionByEndpoint(endpoint), null, 'обрисана претплата се више не налази');
});

test('прозор за обавештења пита сервер шта је упамћено', () => {
  const app = fs.readFileSync('./public/app.js', 'utf8');
  assert.match(app, /function refreshSheetState/, 'мора да постоји читање стања са сервера');
  assert.match(app, /'\/api\/prefs'/, 'адреса претплате иде у телу захтева, не у путањи');

  const sheet = app.slice(app.indexOf('function openSheet'), app.indexOf('async function refreshSheetState'));
  assert.ok(
    sheet.indexOf('prefs.append') < sheet.indexOf('refreshSheetState'),
    'прозор се прво исцрта, па тек онда пита сервер',
  );
});

test('распон дана обухвата последњи јеловник и кад он касни', () => {
  // Четвртог дана без новог јеловника доња граница упита прескочила је
  // горњу, сервер је вратио нула дана, а апликација остала празна. Мерено
  // у прегледачу: from 2026-09-12, to 2026-09-11, нула дана.
  const src = fs.readFileSync('./public/app.js', 'utf8');
  const telo = src.slice(src.indexOf('const shift ='), src.indexOf('const weekdayIndex ='))
    + src.slice(src.indexOf('function menuWindow'), src.indexOf('async function load'));
  const menuWindow = new Function(`${telo}
; return menuWindow;`)();

  // Обичан дан: последња три дана и све што следи.
  assert.deepEqual(menuWindow('2026-09-15', '2026-09-01', '2026-09-30'),
    { from: '2026-09-12', to: '2026-09-30' });

  // Јеловник касни четири дана: прозор мора да се помери уназад до њега.
  const kasni = menuWindow('2026-09-15', '2026-09-01', '2026-09-11');
  assert.ok(kasni.from <= kasni.to, 'доња граница не сме да прескочи горњу');
  assert.equal(kasni.to, '2026-09-11', 'последњи дан који постоји мора да уђе у прозор');
  assert.equal(kasni.from, '2026-09-08');

  // Почетак месеца: не тражи се пре првог дана који уопште постоји.
  assert.equal(menuWindow('2026-09-03', '2026-09-01', '2026-09-15').from, '2026-09-01');
});

test('без данашњег јеловника отвара се последњи дан који постоји', () => {
  // Шеснаестог, док нови PDF не стигне, апликација је отварала најстарији
  // преостали дан и нигде није писало зашто.
  const app = fs.readFileSync('./public/app.js', 'utf8');
  const izbor = app.slice(app.indexOf('const postojeci ='), app.indexOf('renderStrip();'));
  assert.match(izbor, /postojeci\[postojeci\.length - 1\]/, 'бира се последњи дан, не први');
  assert.ok(!/\[\.\.\.state\.days\.keys\(\)\]\[0\]/.test(izbor), 'најстарији дан не сме да буде избор');

  const dan = app.slice(app.indexOf('function renderDay'), app.indexOf('function renderUpNext'));
  assert.match(dan, /state\.today > poslednji/, 'мора да се препозна да јеловника за данас нема');
  assert.match(dan, /још није објављен/, 'мора да пише зашто се гледа стари дан');
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

test('нова верзија апликације стиже одмах, не из другог покушаја', () => {
  // Код се служи из кеша, па се измена виђала тек при следећем отварању, а
  // на телефону је умела да остане заглављена данима.
  const app = fs.readFileSync('./public/app.js', 'utf8');
  assert.match(app, /controllerchange/, 'нови service worker мора да покрене поновно учитавање');
  assert.match(app, /imaoKontrolora/, 'прва посета не сме да се учитава двапут');
  assert.match(app, /ucitavaSe/, 'мора да постоји брана од учитавања у круг');
});

test('прошло је прошло, без обзира на дан', () => {
  const app = fs.readFileSync('./public/app.js', 'utf8');
  assert.match(app, /\(stanje === 'прошло' \? ' past' : ''\)/, 'затамњење не сме да зависи од тога да ли је данас');
  // Ознака "било" остаје само данас: на прошлом дану су сва три прошла.
  assert.match(app, /stanje === 'прошло' && isToday/, 'ознака стоји само на данашњем дану');
});

test('тачкица уз јело седи на средини слова', () => {
  // Мерење пиксела у Chrome-у и у Gecko-у: тачкица мерена од врха реда
  // пада на средину реда, а то је два пиксела изнад средине малих слова.
  // Оба прегледача су грешила једнако. Средину слова прегледач рачуна из
  // фонта кад тачкица стоји у самом реду, као слово.
  const css = fs.readFileSync('./public/styles.css', 'utf8');
  const pravilo = css.slice(css.indexOf('.meal li::before'), css.indexOf('.meal .none'));
  assert.ok(!pravilo.includes('position: absolute'), 'тачкица не сме да буде апсолутно постављена');
  assert.ok(!pravilo.includes('margin-top'), 'тачкица не сме да се мери од врха реда');
  assert.match(pravilo, /vertical-align: middle/, 'поравнање мора да иде по средини слова');

  // Висећи увлак мора да буде тачно колико тачкица са својим размаком,
  // иначе преломљени редови беже испод тачкице.
  const red = css.slice(css.indexOf('.meal li {'), css.indexOf('.meal li::before'));
  const uvlaka = Number(red.match(/padding-left: (\d+)px/)[1]);
  assert.equal(red.match(/text-indent: -(\d+)px/)[1], String(uvlaka), 'увлак и негативни увлак морају да се поклопе');
  const sirina = Number(pravilo.match(/width: (\d+)px/)[1]);
  const razmak = Number(pravilo.match(/margin-right: (\d+)px/)[1]);
  assert.equal(uvlaka, sirina + razmak, 'увлак мора да буде ширина тачкице плус размак');
});

test('померање на оброк ради и кад анимација не може', () => {
  // Мерење у прегледачу: док је страница у позадини, requestAnimationFrame
  // не окида, а глатко клизање се не изводи. Оба ослонца су зато уклоњена
  // из обавезног пута, иначе корисник остане на врху.
  const app = fs.readFileSync('./public/app.js', 'utf8');
  const deo = app.slice(app.indexOf('function focusOnMeal'), app.indexOf('/* ---------- Приказ'));

  assert.match(deo, /document\.visibilityState === 'visible'/, 'глатко клизање само док је страница видљива');
  assert.match(deo, /prefers-reduced-motion/, 'мора да поштује захтев за мање покрета');
  assert.match(deo, /behavior: glatko \? 'smooth' : 'auto'/, 'иначе се помера одмах');
  assert.ok(
    !app.includes('requestAnimationFrame(() => focusOnMeal'),
    'померање не сме да зависи од оквира анимације',
  );
});
