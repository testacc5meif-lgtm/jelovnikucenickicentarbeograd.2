#!/usr/bin/env node
// Скида језичке податке за Tesseract. Покренути једном, пре прве обраде.
// Фајлови су велики па не иду у репозиторијум, него се преузимају овде.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

const BASE = 'https://github.com/tesseract-ocr/tessdata_best/raw/main';
const LANGS = process.argv.slice(2).length ? process.argv.slice(2) : [config.ocr.lang];

fs.mkdirSync(config.ocr.tessdata, { recursive: true });

for (const lang of LANGS) {
  const target = path.join(config.ocr.tessdata, `${lang}.traineddata`);
  if (fs.existsSync(target) && fs.statSync(target).size > 1_000_000) {
    console.log(`  ${lang}: већ постоји`);
    continue;
  }

  process.stdout.write(`  ${lang}: преузимам... `);
  const response = await fetch(`${BASE}/${lang}.traineddata`, { redirect: 'follow' });
  if (!response.ok) {
    console.log(`неуспешно, HTTP ${response.status}`);
    process.exitCode = 1;
    continue;
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(target, bytes);
  console.log(`${(bytes.length / 1e6).toFixed(1)} MB`);
}

console.log(`Језички подаци су у ${config.ocr.tessdata}`);
