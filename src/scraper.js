import crypto from 'node:crypto';
import { config } from './config.js';

const UA = 'JelovnikBot/1.0 (+PWA za jelovnik Ucenickog centra)';

/** Скида HTML стране са које се објављују јеловници. */
async function fetchPage() {
  const response = await fetch(config.sourceUrl, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Страница није доступна: HTTP ${response.status}`);
  return response.text();
}

/**
 * Проналази све PDF линкове на страници. Задржава редослед појављивања,
 * уклања дупликате и филтрира на оне који личе на јеловник.
 */
export function findPdfLinks(html, baseUrl) {
  const links = new Map();
  const pattern = /href\s*=\s*["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    let href;
    try {
      href = new URL(match[1], baseUrl).toString();
    } catch {
      continue;
    }
    if (!links.has(href)) links.set(href, decodeURIComponent(href));
  }

  const all = [...links.entries()].map(([url, readable]) => ({ url, readable }));
  const menus = all.filter(({ readable }) => /јеловник|jelovnik/i.test(readable));
  return menus.length > 0 ? menus : all;
}

/** Скида PDF и враћа бајтове са SHA-256 отиском. */
export async function downloadPdf(url) {
  const response = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!response.ok) throw new Error(`PDF није доступан: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('Преузети фајл није PDF');
  }
  return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/** Враћа листу кандидата за обраду, најновији прво по редоследу на страници. */
export async function discoverMenus() {
  const html = await fetchPage();
  return findPdfLinks(html, config.sourceUrl);
}
