import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

/**
 * Претвара PDF у слике страна, једна слика по страни.
 *
 * Прво покушава pdftoppm, који исправно исцртава сваку страну без обзира
 * на то како је PDF направљен. Ако тог алата нема, вади уграђене JPEG
 * слике из самог фајла. Тај други пут ради само за скениране документе,
 * где је страна тачно једна слика, што овај јеловник и јесте.
 *
 * @returns {Promise<{files: string[], dir: string, method: string}>}
 */
export async function toPageImages(pdfBytes, { dpi = 200 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jelovnik-'));
  const pdfPath = path.join(dir, 'source.pdf');
  fs.writeFileSync(pdfPath, pdfBytes);

  try {
    await run('pdftoppm', ['-r', String(dpi), '-jpeg', pdfPath, path.join(dir, 'page')]);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('page') && f.endsWith('.jpg')).sort();
    if (files.length > 0) {
      return { files: files.map((f) => path.join(dir, f)), dir, method: 'pdftoppm' };
    }
  } catch {
    // pdftoppm није инсталиран, прелазимо на вађење уграђених слика.
  }

  const images = extractJpegStreams(pdfBytes);
  if (images.length === 0) {
    throw new Error('Из PDF-а није извучена ниједна слика. Инсталирај poppler-utils (pdftoppm).');
  }

  const files = images.map((bytes, index) => {
    const file = path.join(dir, `page-${String(index + 1).padStart(2, '0')}.jpg`);
    fs.writeFileSync(file, bytes);
    return file;
  });

  return { files, dir, method: 'ugradjene-slike' };
}

/**
 * Вади JPEG токове из PDF-а тако што прати структуру објеката.
 * Тражи речник са /DCTDecode, па узима садржај између "stream" и
 * "endstream". Поузданије је од тражења JPEG маркера кроз цео фајл,
 * јер сличице у EXIF заглављу носе исте маркере.
 */
function extractJpegStreams(bytes) {
  const haystack = bytes.toString('latin1');
  const images = [];
  let cursor = 0;

  while (true) {
    const marker = haystack.indexOf('/DCTDecode', cursor);
    if (marker === -1) break;

    const streamAt = haystack.indexOf('stream', marker);
    if (streamAt === -1) break;

    // Иза кључне речи stream стоји CRLF или LF, па тек онда подаци.
    let start = streamAt + 'stream'.length;
    if (haystack[start] === '\r') start += 1;
    if (haystack[start] === '\n') start += 1;

    const end = haystack.indexOf('endstream', start);
    if (end === -1) break;

    const data = bytes.subarray(start, end);
    if (data[0] === 0xff && data[1] === 0xd8) images.push(data);
    cursor = end + 'endstream'.length;
  }

  return images;
}

/** Брише привремени директоријум са сликама. */
export function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ако брисање не успе, оперативни систем ће очистити свој temp.
  }
}
