/**
 * POST a tick tx hash to the Sodax solver to nudge intent execution.
 *
 * The leverage vault's `tick()` may emit a `Leveraged` event carrying an intent — the
 * solver picks that up automatically, but a direct POST shortens settlement latency from
 * ~minutes to ~seconds. Best-effort: if the call fails we log + continue (the solver
 * still has its own indexer).
 */

import type { Hash } from 'viem';

export type SolverPostResult = {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
};

export async function notifySolver(apiUrl: string, txHash: Hash): Promise<SolverPostResult> {
  const url = `${apiUrl.replace(/\/+$/, '')}/execute`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent_tx_hash: txHash }),
      // 10s upper bound — solver should ack quickly. Don't block the Lambda.
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
