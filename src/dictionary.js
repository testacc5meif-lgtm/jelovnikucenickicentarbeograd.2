// Исправка OCR грешака помоћу речника већ виђених јела.
//
// Јеловник понавља исти мали скуп јела из циклуса у циклус, па речник
// расте сам од себе и тачност се с временом побољшава. Због тога овде
// нема ниједног тврдо уписаног списка јела: почетни речник је ручни
// препис, а све касније допуњује оно што је већ уписано у базу.

/**
 * Облик слова. Ћирилица и латиница деле низ знакова који се на скену не
 * разликују, па се и једно и друго своди на исти облик. Поређење по
 * облику је оно што спаја "canara" са "салата" и "uaj" са "чај".
 */
const SHAPE = new Map(Object.entries({
  // латиница која се на скену појави уместо ћирилице
  a: 'a', c: 'c', e: 'e', j: 'j', o: 'o', p: 'p', x: 'x', y: 'y',
  u: 'u', n: 'n', r: 't', b: 'b', h: 'h', k: 'k', m: 'm', t: 't', i: 'i',
  // ћирилица
  а: 'a', с: 'c', е: 'e', ј: 'j', о: 'o', р: 'p', х: 'x', у: 'y',
  ч: 'u', п: 'n', л: 'n', т: 't', в: 'b', н: 'h', к: 'k', м: 'm', и: 'i',
  г: 'g', д: 'd', ж: 'z', з: 'z', б: 'b', ф: 'f', ц: 'c', ш: 'w',
  љ: 'nb', њ: 'hb', ђ: 'd', ћ: 'h', џ: 'u',
}));

/** Своди реч на облик, тако да се слична слова изједначе. */
function shapeOf(word) {
  let out = '';
  for (const ch of word.toLowerCase()) out += SHAPE.get(ch) ?? ch;
  return out;
}

const WORD = /[\p{L}\p{N}]+/gu;

function wordsIn(text) {
  return String(text).toLowerCase().match(WORD) || [];
}

/**
 * Гради речник из познатих ставки.
 *
 * Уз сваку реч се памти и колико је пута виђена. То је оно што речнику
 * даје поверење: јело које се понавља из циклуса у циклус види се
 * десетинама пута, док се реч коју је скен једном погрешно прочитао и
 * унео у базу види једном. Исправка се ослања само на често виђене речи,
 * па речник с временом сам постаје чистији.
 *
 * @param {Array<string|{label: string, n: number}>} items ставке из ручног
 *   преписа и из базе. Уз `n` се ставка рачуна као виђена толико пута.
 */
export function buildLexicon(items) {
  const words = new Set();
  const phrases = new Set();
  const byShape = new Map();
  const counts = new Map();

  for (const item of items) {
    const plain = typeof item === 'string';
    const text = String(plain ? item : item?.label ?? '').trim();
    if (!text) continue;
    const times = plain ? 1 : Math.max(1, Number(item.n) || 1);

    phrases.add(text.toLowerCase());
    for (const word of wordsIn(text)) {
      if (word.length < 3) continue;
      words.add(word);
      counts.set(word, (counts.get(word) ?? 0) + times);
      const shape = shapeOf(word);
      if (!byShape.has(shape)) byShape.set(shape, new Set());
      byShape.get(shape).add(word);
    }
  }

  return { words, phrases, byShape, counts };
}

/** Растојање измене, прекинуто чим пређе дозвољену границу. */
function editDistance(a, b, limit = 1) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

const onlyOne = (set) => (set && set.size === 1 ? [...set][0] : null);

const HAS_LATIN = /[A-Za-z]/;

// Колико пута реч мора да буде виђена да би смела да исправља другу.
// Виђена једном може и сама да буде погрешно прочитана, па би исправка
// ка њој ширила грешку.
const TRUST_MIN = 2;

// Најкраћа ћирилична реч која се сме исправљати. Код кратких речи једно
// слово разлике пречесто значи другу реч ("сок" и "сос"), а не грешку.
const CYRILLIC_MIN = 4;

// Колико пута чешћи кандидат мора да буде да би решио нерешено. "јајс" је
// на једно слово и од "јаје" и од "јаја", па одлучује оно што јеловник
// стварно чешће пише.
const CLEAR_WIN = 2;

/**
 * Бира исправку међу кандидатима на једно слово разлике.
 *
 * Један кандидат се узима. Кад их је више, узима се онај који је виђен
 * изразито чешће, јер честа реч јесте оно што јеловник пише. Кад су
 * близу, не дира се ништа: боље непоправљена реч него погрешно поправљена.
 */
function pickByCount(candidates, counts) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const sorted = [...candidates].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  const best = counts.get(sorted[0]) ?? 0;
  const next = counts.get(sorted[1]) ?? 0;
  return best >= next * CLEAR_WIN ? sorted[0] : null;
}

/**
 * Исправља једну реч.
 *
 * Реч у којој се појавила латиница скен је сигурно поквaрио, па се она
 * гледа и по облику слова и по једном промашеном слову.
 *
 * Чиста ћирилична реч се дира много уздржаније. Речник је по природи
 * непотпун, нова јела се појављују стално, па би слободна замена
 * непознате речи сличном познатом чешће квaрила него поправљала. Зато се
 * таква реч мења само кад се све сложи: довољно је дуга, разлика је једно
 * слово унутар речи, завршетак је исти, а познат облик је виђен више пута.
 *
 * Завршетак се не дира зато што у српском он носи падеж, а не грешку.
 * Мерење на јеловнику за октобар 2026: од десет измена које допушта
 * правило без тог услова, седам је покварило исправну реч, и свих седам
 * је мењало последње слово ("месо" у "месом", "паприкаш" у "паприка",
 * "милерам" у "милерама"). Преостале три су биле праве исправке и ниједна
 * није дирала завршетак ("хлаб" у "хлеб", "кромпр" у "кромпир",
 * "мармелаада" у "мармелада"). Зато се поправља само унутрашњост речи.
 */
function correctWord(word, lexicon) {
  const lower = word.toLowerCase();
  if (lower.length < 3 || lexicon.words.has(lower)) return word;

  if (HAS_LATIN.test(lower)) {
    // Прво: иста реч, само прочитана погрешним писмом.
    const byShape = onlyOne(lexicon.byShape.get(shapeOf(lower)));
    if (byShape) return matchCase(word, byShape);

    // Затим: писмо погрешно и уз то једно слово промашено.
    const near = [...lexicon.words].filter((candidate) => editDistance(shapeOf(lower), shapeOf(candidate)) <= 1);
    if (near.length === 1) return matchCase(word, near[0]);

    return word;
  }

  if (lower.length < CYRILLIC_MIN) return word;

  const trusted = [...lexicon.words].filter(
    (candidate) => (lexicon.counts?.get(candidate) ?? 0) >= TRUST_MIN
      && candidate.length >= CYRILLIC_MIN
      && candidate.at(-1) === lower.at(-1)
      && Math.abs(candidate.length - lower.length) <= 1
      && editDistance(lower, candidate) <= 1,
  );

  const pick = pickByCount(trusted, lexicon.counts ?? new Map());
  return pick ? matchCase(word, pick) : word;
}

/** Задржава велико почетно слово оригинала. */
function matchCase(original, replacement) {
  const first = original[0];
  if (first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** Исправља целу ставку, реч по реч, чувајући знакове интерпункције. */
export function correctItem(text, lexicon) {
  if (lexicon.phrases.has(String(text).trim().toLowerCase())) return text;
  return String(text).replace(WORD, (word) => correctWord(word, lexicon));
}

/**
 * Раздваја ставке које су се слепиле зато што је скен изгубио цртицу.
 * Дели само када су оба дела позната јела, што спречава да се исправна
 * сложена ставка погрешно расече.
 */
export function splitMerged(items, lexicon) {
  const out = [];

  for (const item of items) {
    const lower = item.toLowerCase();
    if (lexicon.phrases.has(lower) || !lower.includes(' ')) {
      out.push(item);
      continue;
    }

    const parts = item.split(' ');
    let split = null;

    for (let cut = 1; cut < parts.length && !split; cut += 1) {
      const head = parts.slice(0, cut).join(' ');
      if (!lexicon.phrases.has(head.toLowerCase())) continue;

      const tail = parts.slice(cut).join(' ');
      if (lexicon.phrases.has(tail.toLowerCase())) {
        split = [head, tail];
        continue;
      }

      // Скен понекад прочита цртицу као слово и залепи је за прву реч
      // наредне ставке, па "качкаваљ" постане "скачкаваљ". Ако уклањање
      // тог првог слова даје познато јело, ту је била граница ставке.
      const trimmed = tail.slice(1);
      if (tail.length > 3 && lexicon.phrases.has(trimmed.toLowerCase())) {
        split = [head, trimmed];
      }
    }

    if (split) out.push(...split);
    else out.push(item);
  }

  return out;
}

/** Цео пролаз исправке над једним даном. */
export function correctDay(day, lexicon) {
  const fixed = { ...day };
  for (const meal of ['dorucak', 'rucak', 'vecera']) {
    const corrected = (day[meal] || []).map((item) => correctItem(item, lexicon));
    fixed[meal] = splitMerged(corrected, lexicon);
  }
  return fixed;
}
