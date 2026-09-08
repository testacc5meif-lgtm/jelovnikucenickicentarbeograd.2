// Реконструкција табеле јеловника из координата речи.
//
// Ослања се на две особине документа, обе проверене на правом скену:
// заглавља ДОРУЧАК, РУЧАК и ВЕЧЕРА стоје на истим x координатама у сваком
// дневном блоку, а нова ставка увек почиње цртицом. Увлачење не помаже,
// јер наставак преломљеног реда почиње на истој x координати као и ставка.

const MEALS = ['dorucak', 'rucak', 'vecera'];
const HEADERS = { ДОРУЧАК: 'dorucak', РУЧАК: 'rucak', ВЕЧЕРА: 'vecera' };
const DATE = /(\d{2})\.(\d{2})\.(\d{4})/;
const FOOTER = /Верзија|Страница|примене|АЛЕРГО|НАПОМЕНА|састав/i;
const DASH = /^[-–—]/;

// Растојања унутар блока, изражена у висинама реда, да не зависе од DPI-ја.
const BODY_TOP = 1.3;   // од заглавља до прве ставке
const DATE_BAND = 4;    // колико изнад заглавља тражимо датум
const NEXT_GAP = 3.2;   // колико изнад следећег заглавља блок престаје
const BLOCK_MAX = 16;   // највећа висина последњег блока на страни

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

    // Зарез на крају претходног реда значи да реченица тече даље. Без њега
    // би се "кајгана са крањском кобасицом, / фета сир" расекло надвоје,
    // јер је "фета сир" и само за себе познато јело.
    const continues = /,$/.test(items.at(-1) ?? '');

    const dish = continues ? null : knownDish(text, lexicon);
    if (dish) {
      items.push(dish);
    } else if (cyrillicShare(text) >= 0.6 && meanConfidence(line) >= CONTINUATION_MIN_CONF) {
      items[items.length - 1] += ` ${text}`;
    }
  }

  return items.map(tidy).filter(Boolean);
}

function tidy(text) {
  return text
    .replace(/^["'`«»]+/, '')
    .replace(/\s+([,.)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Издваја дневне блокове са једне стране. */
export function parsePage(allWords, lexicon = null) {
  if (allWords.length === 0) return [];

  const unit = lineHeight(allWords);

  // Подножје стране и потписи не припадају ниједном дану.
  const footerTops = allWords.filter((w) => FOOTER.test(w.text)).map((w) => w.y);
  const footerY = footerTops.length ? Math.min(...footerTops) - unit * 0.3 : Infinity;
  const words = allWords.filter((w) => w.y < footerY);

  const headerRows = toLines(words.filter((w) => HEADERS[w.text]))
    .filter((row) => row.words.length >= 2)
    .map((row) => {
      const columns = {};
      for (const word of row.words) columns[HEADERS[word.text]] = word.cx;
      return { top: row.top, columns };
    })
    .sort((a, b) => a.top - b.top);

  return headerRows.map((header, index) => {
    const bodyTop = header.top + unit * BODY_TOP;
    const next = headerRows[index + 1];
    const bodyEnd = next
      ? next.top - unit * NEXT_GAP
      : Math.min(header.top + unit * BLOCK_MAX, footerY);

    const body = words.filter((w) => w.y > bodyTop && w.y < bodyEnd);

    // Датум стоји изнад заглавља. Читамо само цифре, јер дан у недељи
    // рачунамо из датума, а њега скен често прочита погрешно.
    const above = words.filter((w) => w.y < header.top && w.y > header.top - unit * DATE_BAND);
    const hit = above.map((w) => w.text.match(DATE)).find(Boolean);

    const columns = splitColumns(body, header.columns);
    const day = { date: hit ? `${hit[3]}-${hit[2]}-${hit[1]}` : null };
    for (const meal of MEALS) day[meal] = itemsFrom(toLines(columns[meal]), lexicon);
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
 * Скида отргнуто слово са краја.
 *
 * Испод табеле стоје потписи и линије, а скен из њих понекад отргне
 * усамљено слово и залепи га за крај напомене, па је испадало
 * "...ДО ИЗМЕНЕ ЈЕЛОВНИКА. И". Скидају се два облика: реч од једног или
 * два слова иза тачке, и усамљено слово на самом крају. Ниједан алерген
 * ни српска реченица не завршавају се једним словом.
 */
export function trimTail(text) {
  return text
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
    for (let i = start + 1; i < lines.length; i += 1) {
      if (NEXT_LABEL.test(lines[i].text)) break;
      if (lines[i].top - lines[start].top > unit * 3.5) break;
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

/**
 * Спаја стране у један јеловник и попуњава датуме који нису прочитани.
 * Дани у документу иду узастопно, па недостајући датум следи из положаја
 * блока. Кад прочитан датум одступа од тог низа, дан се означава за проверу.
 */
export function assembleDays(pages) {
  const days = pages.flat();
  const anchor = days.findIndex((day) => day.date);
  if (anchor === -1) return days;

  const base = Date.parse(`${days[anchor].date}T00:00:00Z`);

  return days.map((day, index) => {
    const expected = new Date(base + (index - anchor) * 86400000).toISOString().slice(0, 10);
    if (!day.date) return { ...day, date: expected, dateGuessed: true };
    if (day.date !== expected) return { ...day, dateConflict: expected };
    return day;
  });
}
