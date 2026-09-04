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
 * @param {string[]} items ставке из ручног преписа и из базе
 */
export function buildLexicon(items) {
  const words = new Set();
  const phrases = new Set();
  const byShape = new Map();

  for (const item of items) {
    const text = String(item).trim();
    if (!text) continue;
    phrases.add(text.toLowerCase());
    for (const word of wordsIn(text)) {
      if (word.length < 3) continue;
      words.add(word);
      const shape = shapeOf(word);
      if (!byShape.has(shape)) byShape.set(shape, new Set());
      byShape.get(shape).add(word);
    }
  }

  return { words, phrases, byShape };
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

/**
 * Исправља једну реч.
 *
 * Дира само речи у којима се појавила латиница, што значи да их је скен
 * поквaрио. Чиста ћирилична реч се не прегледа ни кад је нема у речнику:
 * речник је по природи непотпун, јер се нова јела појављују стално, па
 * би „исправка" непознате речи у сличну познату била чешће штета него
 * корист. Мерење на скривених осам дана то и показује.
 */
function correctWord(word, lexicon) {
  const lower = word.toLowerCase();
  if (lower.length < 3 || !HAS_LATIN.test(lower) || lexicon.words.has(lower)) return word;

  // Прво: иста реч, само прочитана погрешним писмом.
  const byShape = onlyOne(lexicon.byShape.get(shapeOf(lower)));
  if (byShape) return matchCase(word, byShape);

  // Затим: писмо погрешно и уз то једно слово промашено.
  const near = [...lexicon.words].filter((candidate) => editDistance(shapeOf(lower), shapeOf(candidate)) <= 1);
  if (near.length === 1) return matchCase(word, near[0]);

  return word;
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
