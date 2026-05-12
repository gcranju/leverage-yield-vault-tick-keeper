/**
 * Dual entry point: AWS Lambda (`handler`) + local CLI (`once` / `loop`).
 *
 *   AWS Lambda → set `dist/handler.handler` as the function handler.
 *   Local      → `pnpm run once` (single pass) or `pnpm run loop 60` (every 60 s).
 */

import 'dotenv/config';
import type { Context, ScheduledEvent, ScheduledHandler } from 'aws-lambda';
import { loadConfig } from './config.js';
import { runKeeper } from './keeper.js';

/** AWS Lambda entry. Wire to an EventBridge rule (e.g. `rate(5 minutes)`). */
export const handler: ScheduledHandler = async (_event: ScheduledEvent, _context: Context) => {
  const cfg = loadConfig();
  await runKeeper(cfg);
};

/** Local CLI: `tsx src/handler.ts once|loop [intervalSec]`. */
async function localMain(): Promise<void> {
  const cfg = loadConfig();
  const mode = process.argv[2] ?? 'once';

  if (mode === 'loop') {
    const intervalSec = Number.parseInt(process.argv[3] ?? '60', 10);
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'loop-start', intervalSec }));
    while (true) {
      try {
        await runKeeper(cfg);
      } catch (e) {
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'error',
            msg: 'pass-failure',
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
      await new Promise(r => setTimeout(r, intervalSec * 1000));
    }
  } else if (mode === 'once') {
    await runKeeper(cfg);
  } else {
    console.error(`Unknown mode: ${mode}. Use "once" or "loop [intervalSec]".`);
    process.exit(1);
  }
}

// Run the CLI only when invoked directly (not when imported by Lambda).
// import.meta.url comparison is the ESM equivalent of `require.main === module`.
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  localMain().catch(err => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', error: err?.message ?? String(err) }));
    process.exit(1);
  });
}
