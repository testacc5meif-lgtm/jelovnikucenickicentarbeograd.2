// Пресловљавање латинице у српску ћирилицу.
// Служи као заштитна мрежа: извор је тренутно на ћирилици, али ако неки
// будући јеловник стигне на латиници, текст улази у базу већ пресловљен.

const DIGRAPHS = [
  ['DŽ', 'Џ'], ['Dž', 'Џ'], ['dž', 'џ'],
  ['DJ', 'Ђ'], ['Dj', 'Ђ'], ['dj', 'ђ'],
  ['LJ', 'Љ'], ['Lj', 'Љ'], ['lj', 'љ'],
  ['NJ', 'Њ'], ['Nj', 'Њ'], ['nj', 'њ'],
];

const SINGLES = {
  A: 'А', B: 'Б', V: 'В', G: 'Г', D: 'Д', Đ: 'Ђ', E: 'Е', Ž: 'Ж', Z: 'З',
  I: 'И', J: 'Ј', K: 'К', L: 'Л', M: 'М', N: 'Н', O: 'О', P: 'П', R: 'Р',
  S: 'С', T: 'Т', Ć: 'Ћ', U: 'У', F: 'Ф', H: 'Х', C: 'Ц', Č: 'Ч', Š: 'Ш',
  a: 'а', b: 'б', v: 'в', g: 'г', d: 'д', đ: 'ђ', e: 'е', ž: 'ж', z: 'з',
  i: 'и', j: 'ј', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', r: 'р',
  s: 'с', t: 'т', ć: 'ћ', u: 'у', f: 'ф', h: 'х', c: 'ц', č: 'ч', š: 'ш',
};

// Речи у којима су "nj", "lj" или "dj" два одвојена гласа, не диграф.
const EXCEPTIONS = new Map([
  ['konjunkcija', 'конјункција'],
  ['injekcija', 'инјекција'],
  ['injekcije', 'инјекције'],
  ['nadživeti', 'надживети'],
  ['podžanr', 'поджанр'],
]);

const CYRILLIC = /[Ѐ-ӿ]/;

/** Тачно ако низ већ садржи ћирилицу. */
export function isCyrillic(text) {
  return CYRILLIC.test(text);
}

function convertWord(word) {
  const exception = EXCEPTIONS.get(word.toLowerCase());
  if (exception) {
    // Задржи почетно велико слово ако га је реч имала.
    return word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()
      ? exception[0].toUpperCase() + exception.slice(1)
      : exception;
  }

  let out = '';
  let i = 0;
  while (i < word.length) {
    const pair = word.slice(i, i + 2);
    const digraph = DIGRAPHS.find(([latin]) => latin === pair);
    if (digraph) {
      out += digraph[1];
      i += 2;
      continue;
    }
    const ch = word[i];
    out += SINGLES[ch] ?? ch;
    i += 1;
  }
  return out;
}

/**
 * Пресловљава латинички текст у ћирилицу. Текст који већ садржи ћирилицу
 * враћа се нетакнут, да се мешовити записи не би поквариле.
 */
export function toCyrillic(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (isCyrillic(text)) return text;
  return text.replace(/[A-Za-zČĆŽŠĐčćžšđ]+/g, convertWord);
}
