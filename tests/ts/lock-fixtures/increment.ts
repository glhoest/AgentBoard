import { withLock } from '../../../scripts/lib/lock';
import { readFileSync, writeFileSync } from 'node:fs';
const [root, counter] = Bun.argv.slice(2);
for (let i = 0; i < 25; i++) withLock(root, () => {
  const n = Number(readFileSync(counter, 'utf8'));
  writeFileSync(counter, String(n + 1));
});
