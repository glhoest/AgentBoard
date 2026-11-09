// Takes the project lock, announces it on stdout, then holds it until killed.
import { withLock } from '../../../scripts/lib/lock';
const [root] = Bun.argv.slice(2);
withLock(root, () => {
  console.log('locked');
  Bun.sleepSync(60000);
});
