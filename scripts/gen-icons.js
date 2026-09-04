#!/usr/bin/env node
// Генерише иконе за PWA без спољних зависности.
//
// Мотив: тањир са поклопцем. Купола, ручка на врху и тањир који вири са
// обе стране куполе. Тањир шири од куполе даје обрис који се препознаје и
// на 48 пиксела, где укрштени прибор изгуби зупце и претвори се у мрљу.
// Ниједан део цртежа није тањи од три пиксела на најмањем приказу.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

/* ---------- Записивање PNG-а ---------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // филтер: ниједан
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // дубина по каналу
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- Геометрија цртежа, у распону 0..1 ---------- */

const DOME = { cx: 0.5, cy: 0.645, r: 0.235 };
const KNOB = { cx: 0.5, cy: 0.345, r: 0.056 };
const NECK = { x0: 0.470, x1: 0.530, y0: 0.345, y1: 0.425 };
const PLATE = { x0: 0.175, x1: 0.825, y0: 0.645, y1: 0.716 };

const inCircle = (u, v, c) => Math.hypot(u - c.cx, v - c.cy) <= c.r;
const inRect = (u, v, r) => u >= r.x0 && u <= r.x1 && v >= r.y0 && v <= r.y1;

/** Тањир: правоугаоник са потпуно заобљеним крајевима. */
function inPlate(u, v) {
  const radius = (PLATE.y1 - PLATE.y0) / 2;
  const cy = PLATE.y0 + radius;
  const left = PLATE.x0 + radius;
  const right = PLATE.x1 - radius;
  if (u >= left && u <= right) return v >= PLATE.y0 && v <= PLATE.y1;
  const cx = u < left ? left : right;
  return Math.hypot(u - cx, v - cy) <= radius;
}

/** Цео мотив као унија четири облика. */
function inCloche(u, v) {
  if (inPlate(u, v)) return true;
  if (v <= DOME.cy && inCircle(u, v, DOME)) return true; // горња половина куполе
  if (inRect(u, v, NECK)) return true;
  return inCircle(u, v, KNOB);
}

/** Заобљени квадрат, подлога иконе. */
function inRoundedSquare(u, v, radius) {
  const dx = Math.max(radius - u, 0, u - (1 - radius));
  const dy = Math.max(radius - v, 0, v - (1 - radius));
  return dx * dx + dy * dy <= radius * radius;
}

/* ---------- Исцртавање ---------- */

const BG = [29, 99, 209];
const FG = [255, 255, 255];
const SAMPLES = 4; // подузорковање 4x4 по пикселу, за глатке ивице

/**
 * @param {number} size странa у пикселима
 * @param {object} options
 *   `scale` мање од 1 смањује мотив, за maskable иконе које систем сече
 *   `bleed` попуњава цео квадрат бојом, без заобљених углова
 *   `silhouette` враћа само бели мотив на провидној подлози, за беџ
 */
function render(size, { scale = 1, bleed = false, silhouette = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const total = SAMPLES * SAMPLES;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bg = 0;
      let fg = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const u = (x + (sx + 0.5) / SAMPLES) / size;
          const v = (y + (sy + 0.5) / SAMPLES) / size;
          if (bleed || inRoundedSquare(u, v, 0.22)) bg += 1;
          if (inCloche(0.5 + (u - 0.5) / scale, 0.5 + (v - 0.5) / scale)) fg += 1;
        }
      }

      const bgA = bg / total;
      const fgA = fg / total;
      const offset = (y * size + x) * 4;

      if (silhouette) {
        rgba.set(FG, offset);
        rgba[offset + 3] = Math.round(255 * fgA);
        continue;
      }

      for (let channel = 0; channel < 3; channel += 1) {
        rgba[offset + channel] = Math.round(BG[channel] * (1 - fgA) + FG[channel] * fgA);
      }
      rgba[offset + 3] = Math.round(255 * bgA);
    }
  }

  return encodePng(size, rgba);
}

/* ---------- SVG, иста геометрија помножена са 512 ---------- */

const s = (value) => Number((value * 512).toFixed(1));

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Јеловник">
  <rect width="512" height="512" rx="113" fill="#1d63d1"/>
  <g fill="#fff">
    <circle cx="${s(KNOB.cx)}" cy="${s(KNOB.cy)}" r="${s(KNOB.r)}"/>
    <rect x="${s(NECK.x0)}" y="${s(NECK.y0)}" width="${s(NECK.x1 - NECK.x0)}" height="${s(NECK.y1 - NECK.y0)}"/>
    <path d="M${s(DOME.cx - DOME.r)} ${s(DOME.cy)} a${s(DOME.r)} ${s(DOME.r)} 0 0 1 ${s(DOME.r * 2)} 0 z"/>
    <rect x="${s(PLATE.x0)}" y="${s(PLATE.y0)}" width="${s(PLATE.x1 - PLATE.x0)}" height="${s(PLATE.y1 - PLATE.y0)}" rx="${s((PLATE.y1 - PLATE.y0) / 2)}"/>
  </g>
</svg>
`;

/* ---------- Излаз ---------- */

const files = [
  ['icon-192.png', render(192)],
  ['icon-512.png', render(512)],
  // Систем maskable икону сече у круг, па мотив мора да стане у ужи круг.
  ['icon-512-maskable.png', render(512, { scale: 0.72, bleed: true })],
  ['badge-96.png', render(96, { silhouette: true })],
  ['icon.svg', SVG],
];

for (const [name, data] of files) {
  fs.writeFileSync(path.join(outDir, name), data);
  console.log(`  ${name}`);
}

console.log('Иконе су записане у public/icons/');
