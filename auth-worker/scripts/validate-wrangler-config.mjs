import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const allowPlaceholders = process.argv.includes('--allow-placeholders');
const configPath = resolve('wrangler.toml');
const config = readFileSync(configPath, 'utf8');
const placeholders = [...config.matchAll(/REPLACE_WITH_[A-Z0-9_]+/g)].map((match) => match[0]);

if (!allowPlaceholders && placeholders.length > 0) {
  const unique = [...new Set(placeholders)].sort();
  console.error(`wrangler.toml still contains placeholder resource ids: ${unique.join(', ')}`);
  process.exit(1);
}
