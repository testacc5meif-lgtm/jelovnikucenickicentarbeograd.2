#!/usr/bin/env node
// Подиже локални Postgres за развој, без инсталације на систем.
// Штампа адресу и остаје да ради док се не прекине.
//
//   npm run pg
//   DATABASE_URL=<адреса из излаза> DATABASE_SSL=false npm start
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const PORT = Number(process.env.PG_PORT || 54329);
const dataDir = process.env.PG_DIR || path.join(os.tmpdir(), 'jelovnik-pg-dev');
const fresh = !fs.existsSync(dataDir);

const { default: EmbeddedPostgres } = await import('embedded-postgres');

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: true,
});

if (fresh) await server.initialise();
await server.start();

if (fresh) {
  // Изричито UTF8: подразумевано кодирање прати локалне поставке система
  // и на Windows-у испадне WIN1252, у коме ћирилица не може да се упише.
  const admin = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${PORT}/postgres` });
  await admin.connect();
  await admin.query("CREATE DATABASE jelovnik WITH ENCODING 'UTF8' TEMPLATE template0");
  await admin.end();
}

const url = `postgres://postgres:postgres@localhost:${PORT}/jelovnik`;
console.log(`Postgres ради. Подаци: ${dataDir}`);
console.log(`\nDATABASE_URL=${url}`);
console.log('DATABASE_SSL=false\n');
console.log('Прекид са Ctrl+C.');

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
