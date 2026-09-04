import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const run = promisify(execFile);

// Ивице табеле Tesseract чита као засебне речи од једног знака. Оне помераju
// почетак реда и кваре препознавање цртице, па се одбацују пре обраде.
// Цртица се овде намерно чува: она означава почетак ставке.
const BORDER_NOISE = /^[|!_[\]{}i1lI.,;:'"`^~\\/=+*<>]{1,2}$/;

/**
 * Пушта једну слику кроз Tesseract и враћа речи са координатама.
 * Координате су оно што нам треба, јер се табела реконструише
 * геометријски, а не из редоследа текста.
 */
export async function readWords(imagePath) {
  const base = imagePath.replace(/\.[^.]+$/, '');
  const args = [
    imagePath,
    base,
    '-l', config.ocr.lang,
    '--psm', '6',
    '--tessdata-dir', config.ocr.tessdata,
    '-c', 'tessedit_create_tsv=1',
  ];

  try {
    await run(config.ocr.binary, args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `Tesseract није пронађен као "${config.ocr.binary}". Инсталирај га или подеси TESSERACT_BIN.`,
      );
    }
    throw error;
  }

  const tsvPath = `${base}.tsv`;
  if (!fs.existsSync(tsvPath)) throw new Error(`Tesseract није направио ${path.basename(tsvPath)}`);

  const words = [];
  for (const row of fs.readFileSync(tsvPath, 'utf8').split('\n').slice(1)) {
    const f = row.split('\t');
    if (f.length < 12) continue;

    const text = f[11].trim();
    if (!text || BORDER_NOISE.test(text)) continue;

    const x = Number(f[6]);
    const y = Number(f[7]);
    const w = Number(f[8]);
    const h = Number(f[9]);
    words.push({ x, y, w, h, text, conf: Number(f[10]), cx: x + w / 2, cy: y + h / 2 });
  }

  return words;
}

/** Проверава да ли су Tesseract и језички подаци спремни. */
export async function checkOcr() {
  const dataFile = path.join(config.ocr.tessdata, `${config.ocr.lang}.traineddata`);
  if (!fs.existsSync(dataFile)) {
    return { ok: false, reason: `недостају језички подаци: ${dataFile}. Покрени: npm run tessdata` };
  }
  try {
    const { stdout } = await run(config.ocr.binary, ['--version'], { maxBuffer: 1024 * 1024 });
    return { ok: true, version: stdout.split('\n')[0].trim() };
  } catch {
    return { ok: false, reason: `Tesseract није извршив као "${config.ocr.binary}"` };
  }
}
