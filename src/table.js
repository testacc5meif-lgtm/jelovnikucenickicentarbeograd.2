// Реконструкција табеле јеловника из координата речи.
//
// Ослања се на три особине документа, све проверене на правом скену:
// дан почиње редом који отвара датум, заглавља ДОРУЧАК, РУЧАК и ВЕЧЕРА
// стоје на истим x координатама кроз цео документ, а нова ставка увек
// почиње цртицом. Увлачење не помаже, јер наставак преломљеног реда
// почиње на истој x координати као и ставка.
//
// Дан се тражи по датуму, а не по заглављу колона, зато што документ то
// заглавље не понавља уз сваки дан. У јеловнику за октобар 2026. дани
// 02.10. и 14.10. немају своје заглавље: испод датума одмах почињу јела.
// Док су се блокови тражили по заглављима, та два дана нису постојала, а
// њихова јела су се прелила у претходни дан.

const MEALS = ['dorucak', 'rucak', 'vecera'];
const HEADERS = { ДОРУЧАК: 'dorucak', РУЧАК: 'rucak', ВЕЧЕРА: 'vecera' };
const DATE = /(\d{2})\.(\d{2})\.(\d{4})/;
const FOOTER = /Верзија|Страница|примене|АЛЕРГО|НАПОМЕНА|састав/i;
const DASH = /^[-–—]/;

// Крај реда после кога ставка сигурно тече даље: зарез, или везник
// који сам за себе не може да затвори ставку.
const CONTINUES = /(?:,|(?:^|\s)(?:и|са|од|у))\s*$/u;

// Подножје стране почиње одмах испод табеле, па се блок последњег дана
// затвара на њему. Израз је у висинама реда, да не зависи од DPI-ја.
const FOOTER_GAP = 0.3;

/** Групише речи у визуелне редове по вертикалном положају. */
export function toLines(words) {
  const lines = [];
  for (const word of [...words].sort((a, b) => a.cy - b.cy)) {
    const last = lines.at(-1);
    if (last && Math.abs(word.cy - last.cy) < word.h * 0.6) {
      last.words.push(word);
      last.cy = last.words.reduce((sum, w) => sum + w.cy, 0) / last.words.length;
    } else {
      lines.push({ cy: word.cy, words: [word] });
    }
  }

  for (const line of lines) {
    line.words.sort((a, b) => a.x - b.x);
    line.text = line.words.map((w) => w.text).join(' ');
    line.left = line.words[0].x;
    line.top = Math.min(...line.words.map((w) => w.y));
  }
  return lines;
}

/** Типична висина реда на страни, основа за сва растојања. */
function lineHeight(words) {
  const heights = words.map((w) => w.h).sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)] || 30;
}

/** Удео ћирилице међу словима реда. */
function cyrillicShare(text) {
  const letters = text.match(/\p{L}/gu) || [];
  if (letters.length === 0) return 0;
  return letters.filter((ch) => /[Ѐ-ӿ]/.test(ch)).length / letters.length;
}

/** Просечна поузданост читања реда, коју Tesseract сам пријављује. */
function meanConfidence(line) {
  const values = line.words.map((w) => w.conf).filter((v) => Number.isFinite(v));
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Мерење на правом скену: линије табеле Tesseract прочита као речи са
// поузданошћу испод 36, док прави текст стоји изнад 90. Праг на средини
// раздваја то двоје без дирања садржаја.
const CONTINUATION_MIN_CONF = 60;

/**
 * Ако ред јесте познато јело, враћа га у исправном облику.
 * Проверава и облик без првог слова, јер скен уме да прочита цртицу као
 * слово и залепи је за реч, па "качкаваљ" постане "скачкаваљ".
 */
function knownDish(text, lexicon) {
  if (!lexicon) return null;
  if (lexicon.phrases.has(text.toLowerCase())) return text;
  const trimmed = text.slice(1);
  if (text.length > 3 && lexicon.phrases.has(trimmed.toLowerCase())) return trimmed;
  return null;
}

/**
 * Спаја редове у ставке. Цртица на почетку реда отвара нову ставку.
 *
 * Ред без цртице је обично наставак претходне ставке, али не увек: скен
 * понекад изгуби цртицу, а понекад линију табеле прочита као реч. Ниска
 * поузданост читања не раздваја то двоје, јер је има у оба случаја, па
 * одлуку доноси речник већ виђених јела.
 */
export function itemsFrom(lines, lexicon = null) {
  const usable = lines.filter((line) => line.text.replace(/[^\p{L}\d]/gu, '').length >= 2);
  const items = [];

  for (const line of usable) {
    const starts = DASH.test(line.text);
    const text = line.text.replace(DASH, '').trim();

    if (starts || items.length === 0) {
      items.push(text);
      continue;
    }

    // Зарез или везник на крају претходног реда значи да реченица тече
    // даље. Без зареза би се "кајгана са крањском кобасицом, / фета сир"
    // расекло надвоје, јер је "фета сир" и само за себе познато јело. Без
    // везника исто тако "...чоколадно млеко и / кифла", јер је и "кифла"
    // познато јело.
    const continues = CONTINUES.test(items.at(-1) ?? '');

    const dish = continues ? null : knownDish(text, lexicon);
    if (dish) {
      items.push(dish);
    } else if (cyrillicShare(text) >= 0.6 && meanConfidence(line) >= CONTINUATION_MIN_CONF) {
      items[items.length - 1] += ` ${text}`;
    }
  }

  return items.map(tidy).filter(Boolean);
}

// Јеловник пише јела малим словом, без изузетка: у два ручно преписана
// циклуса, 390 ставки, нема ниједног великог слова. Скен ипак понекад
// прочита ћ као Ћ, па испадне "Ћуфта". Велико слово иза кога иде мало
// враћа се у мало. Реч у целости великим словима остаје како јесте.
const BIG_LETTER = /\p{Lu}(?=\p{Ll})/gu;

// Разломак ¼ скен не прочита, него врати "%" или "7". У овом документу
// стоји само уз млеко у ланч пакету ("млеко ¼ и кифла"), па се ту враћа.
const QUARTER = /(млеко)\s+[%7]\s+(и)(?=\s|$)/giu;

function tidy(text) {
  return text
    .replace(QUARTER, '$1 ¼ $2')
    .replace(/^["'`«»]+/, '')
    .replace(/\s+([,.)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s{2,}/g, ' ')
    .replace(/^(.*\([^()]*)$/u, '$1)')
    .replace(BIG_LETTER, (letter) => letter.toLowerCase())
    .trim();
}

// Заглавље стране носи период, дакле и датум: "Од 01.10. до 15.10.2026.г.".
// Непун датум у њему, без године, служи да се то заглавље препозна.
const PART_DATE = /\d{2}\.\d{2}\./;

// Дан у недељи стоји уз датум, у загради. Кад га скен одвоји у свој ред,
// тај ред падне у претходни дан и залепи се за његову последњу ставку, па
// је испадало "...(жито са шлагом- жито) (субота)". Ред који носи само дан
// у недељи не припада ниједном оброку.
const WEEKDAY = /(понедељак|уторак|среда|четвртак|петак|субота|недеља)/i;

function isDayLabel(line) {
  if (!WEEKDAY.test(line.text)) return false;
  const rest = line.text.replace(WEEKDAY, '').match(/\p{L}/gu) || [];
  return rest.length <= 3;
}

// Колико слова сме да стоји лево од датума пре него што ред престане да
// буде дан. Скен уз неке дане добаци отргнуто слово од ивице табеле
// ("И", "С"), а то је једно слово. У заглављу стране пре датума стоје
// речи "Од" и "до" уз још текста, дакле пет слова и више.
const NOISE_LETTERS = 2;

/**
 * Датум дана, ако ред почиње датумом.
 *
 * Датум сам по себи не означава дан, јер га носи и заглавље стране. Дан се
 * познаје по положају: његов датум отвара ред, а лево од датума сме да
 * стоји само оно што је скен добацио од линија табеле.
 */
function dayDate(line) {
  let letters = 0;

  for (const word of line.words) {
    const hit = word.text.match(DATE);
    if (hit) return letters <= NOISE_LETTERS ? `${hit[3]}-${hit[2]}-${hit[1]}` : null;

    if (PART_DATE.test(word.text)) return null;
    letters += (word.text.match(/\p{L}/gu) || []).length;
    if (letters > NOISE_LETTERS) return null;
  }

  return null;
}

/**
 * Средишта трију колона, из свих заглавља у целом документу.
 *
 * Заглавља стоје на истим x координатама у сваком блоку, али их документ
 * не понавља уз сваки дан. Зато се средина колоне узима из свих страна
 * одједном, као медијана прочитаних заглавља, и важи и за дан који своје
 * заглавље нема. Медијана, а не просек, да једно промашено читање не
 * помери границу.
 */
export function headerColumns(pages) {
  const found = { dorucak: [], rucak: [], vecera: [] };
  for (const words of pages) {
    for (const word of words) {
      const meal = HEADERS[word.text];
      if (meal) found[meal].push(word.cx);
    }
  }

  const columns = {};
  for (const [meal, list] of Object.entries(found)) {
    if (list.length === 0) continue;
    const sorted = [...list].sort((a, b) => a - b);
    columns[meal] = sorted[Math.floor(sorted.length / 2)];
  }
  return columns;
}

/**
 * Издваја дневне блокове са једне стране.
 *
 * `columns` су средишта колона измерена на целом документу. Ако их нема,
 * мере се на самој страни, што је довољно за страну која има бар једно
 * заглавље.
 */
export function parsePage(allWords, lexicon = null, columns = null) {
  if (allWords.length === 0) return [];

  const unit = lineHeight(allWords);

  // Подножје стране и потписи не припадају ниједном дану.
  const footerTops = allWords.filter((w) => FOOTER.test(w.text)).map((w) => w.y);
  const footerY = footerTops.length ? Math.min(...footerTops) - unit * FOOTER_GAP : Infinity;
  const words = allWords.filter((w) => w.y < footerY);

  const columnX = columns ?? headerColumns([words]);
  const lines = toLines(words);

  const anchors = [];
  lines.forEach((line, index) => {
    const date = dayDate(line);
    if (date) anchors.push({ index, date });
  });

  return anchors.map((anchor, order) => {
    const next = anchors[order + 1];
    const body = lines
      .slice(anchor.index + 1, next ? next.index : lines.length)
      .filter((line) => !isDayLabel(line))
      .flatMap((line) => line.words)
      // Заглавље колона није јело. Избацује се по имену, па не мора да се
      // погађа који је ред заглавље: уз неке дане оно стоји у истом реду
      // са датумом, уз неке у свом, а уз неке га нема.
      .filter((word) => !HEADERS[word.text]);

    const byColumn = splitColumns(body, columnX);
    const day = { date: anchor.date };
    for (const meal of MEALS) day[meal] = itemsFrom(toLines(byColumn[meal]), lexicon);
    return day;
  });
}

/** Дели речи у три колоне по средини између заглавља. */
function splitColumns(words, headerX) {
  const first = headerX.dorucak;
  const second = headerX.rucak;
  const third = headerX.vecera;

  // Ако неко заглавље није прочитано, границе се изводе из ширине текста.
  const spread = words.length ? Math.max(...words.map((w) => w.cx)) : 1;
  const left = first ?? spread * 0.2;
  const middle = second ?? spread * 0.5;
  const right = third ?? spread * 0.8;

  const boundary1 = (left + middle) / 2;
  const boundary2 = (middle + right) / 2;

  const columns = { dorucak: [], rucak: [], vecera: [] };
  for (const word of words) {
    const meal = word.cx < boundary1 ? 'dorucak' : word.cx < boundary2 ? 'rucak' : 'vecera';
    columns[meal].push(word);
  }
  return columns;
}

/**
 * Извлачи алерго податке и напомену са дна документа.
 * Обе линије почињу ознаком иза које следи двотачка.
 */
const NEXT_LABEL = /^(АЛЕРГО|НАПОМЕНА|ЈЕЛОВНИК|Јеловник|Верзија|Страница)/i;

/**
 * Скида реп који је скен добацио испод табеле.
 *
 * Испод табеле стоје потписи, печат и линије за потпис. Скен их прочита
 * као неколико кратких речи и залепи их за крај напомене, па је испадало
 * "...ДО ИЗМЕНЕ ЈЕЛОВНИКА. И У И река .".
 *
 * Реп се познаје по томе што стоји иза завршене реченице и што су му све
 * речи кратке. Права друга реченица има бар једну реч од пет или више
 * слова, па се не дира. Исто важи за алергене, који уопште немају тачку.
 */
// До шест речи од највише четири слова иза завршене реченице, уз тачку
// или две које скен добаци за њима.
const TAIL = /([.!?])(?:\s+\p{L}{1,4}){1,6}[\s.!?]*$/u;

export function trimTail(text) {
  return String(text)
    .replace(TAIL, '$1')
    .replace(/([.!?])\s+\p{L}{1,2}\s*$/u, '$1')
    .replace(/\s+\p{L}\s*$/u, '')
    .replace(/[\s,;:]+$/u, '')
    .trim();
}

export function parseFooter(allWords) {
  const lines = toLines(allWords);

  const grab = (label) => {
    const start = lines.findIndex((line) => label.test(line.text));
    if (start === -1) return '';

    let text = lines[start].text;
    const unit = lines[start].words[0].h;

    // Оба податка се често преламају у следећи ред, који нема своју ознаку.
    //
    // Испод напомене стоје потписи и печат. Њих скен чита слабо, са
    // поузданошћу дубоко испод прага, док прави текст стоји изнад 90. Тај
    // праг их одваја, па реп и не настане. Исти праг важи и за наставак
    // ставке у табели, из истог разлога.
    for (let i = start + 1; i < lines.length; i += 1) {
      if (NEXT_LABEL.test(lines[i].text)) break;
      if (lines[i].top - lines[start].top > unit * 3.5) break;
      if (meanConfidence(lines[i]) < CONTINUATION_MIN_CONF) break;
      text += ` ${lines[i].text}`;
    }

    return trimTail(
      text
        .replace(label, '')
        .replace(/^\s*:?\s*/, '')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    );
  };

  return {
    allergens: grab(/АЛЕРГО\s*ИНФО/i),
    note: grab(/НАПОМЕНА/i),
  };
}

const DAY_MS = 86400000;
const asTime = (iso) => Date.parse(`${iso}T00:00:00Z`);
const asIso = (time) => new Date(time).toISOString().slice(0, 10);

/**
 * Спаја стране у један јеловник и попуњава датуме који нису прочитани.
 *
 * Прочитан датум је извор истине. Раније се датум изводио из редног броја
 * блока, уз претпоставку да блокови иду као узастопни дани. Та
 * претпоставка је пала на јеловнику за октобар 2026: документ прескаче
 * дан, а скен уз то изгуби блок, па је сваки дан испао померен за један и
 * цео јеловник је био одбијен иако су сви датуми прочитани тачно.
 *
 * Сад из редоследа следи само онај датум који скен није прочитао, и то из
 * растојања између суседа који јесу прочитани. Означава се једино прекид
 * монотоности, јер датум који није после претходног значи да подела на
 * дане више не прати документ.
 */
export function assembleDays(pages) {
  const days = pages.flat().map((day) => ({ ...day }));
  if (!days.some((day) => day.date)) return days;

  for (let i = 0; i < days.length; i += 1) {
    if (days[i].date) continue;

    let before = i - 1;
    while (before >= 0 && !days[before].date) before -= 1;
    let after = i + 1;
    while (after < days.length && !days[after].date) after += 1;

    const known = before >= 0 ? days[before].date : null;
    const later = after < days.length ? days[after].date : null;

    if (known && later) {
      // Датум се изводи само кад је низ јединствен, дакле кад на свако
      // празно место дође тачно један дан. Ако је растојање веће, документ
      // је уз непрочитан датум прескочио и дан, па се не зна који је од
      // прескочених ово. Погађање би јела приписало погрешном дану, а то је
      // горе од дана који недостаје, па датум остаје непознат и дан испада
      // у `normalize`. Рупа се потом сама пријави као упозорење.
      const span = (asTime(later) - asTime(known)) / DAY_MS;
      if (span !== after - before) continue;
      days[i].date = asIso(asTime(known) + (i - before) * DAY_MS);
    } else if (known) {
      days[i].date = asIso(asTime(known) + (i - before) * DAY_MS);
    } else {
      days[i].date = asIso(asTime(later) - (after - i) * DAY_MS);
    }
    days[i].dateGuessed = true;
  }

  for (let i = 1; i < days.length; i += 1) {
    if (asTime(days[i].date) <= asTime(days[i - 1].date)) {
      days[i].dateConflict = days[i - 1].date;
    }
  }

  return days;
}
