// Reads a board like a CLI read would, and logs every upgrade-on-read write it performs to LOG.
// Usage: bun upgrade-reader.ts ROOT LOG (snapshot | get ID)
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as store from '../../../scripts/lib/store';

const [root, log, mode, id] = Bun.argv.slice(2);
store.seams.onUpgrade = (path, from, to) => appendFileSync(log, `${process.pid} ${basename(path)} ${from} ${to}\n`);
if (mode === 'get') store.get(root, id);
else store.snapshot(root);
