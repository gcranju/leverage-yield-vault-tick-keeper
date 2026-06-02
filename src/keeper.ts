/**
 * Core keeper loop. For each registered vault:
 *   1. Read position + targetLTV + ltvTolerance
 *   2. Compute |currentLTV - targetLTV| → if > tolerance, tick is needed
 *   3. Call vault.tick() — emits Leveraged / Deleveraged / Rebalanced
 *   4. If Leveraged event present, POST tx hash to the solver to nudge fill
 *
 * Each vault is processed independently — one vault's revert doesn't block others.
 * All structured logs go to stdout (CloudWatch ingests them as-is).
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  decodeEventLog,
  type Account,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sonic } from 'viem/chains';
import type { KeeperConfig, LeverageYieldVault } from './config.js';
import { notifySolver } from './solver.js';

// Minimal ABI fragment — only what the keeper needs.
const VAULT_ABI = parseAbi([
  'function tick()',
  'function targetLTV() view returns (uint256)',
  'function ltvTolerance() view returns (uint256)',
  'function getPositionDetails() view returns (uint256 collateral, uint256 debt, uint256 ltv, uint256 healthFactor, uint256 idleAsset)',
  'event Leveraged(uint256 borrowAmount, uint256 expectedAssetAmount)',
  'event Deleveraged(uint256 assetAmountWithdrawn, uint256 borrowRepayAmount)',
  'event Rebalanced(uint256 currentLTV, uint256 targetLTV)',
]);

const LEVERAGED_EVENT = parseAbiItem(
  'event Leveraged(uint256 borrowAmount, uint256 expectedAssetAmount)',
);
const DELEVERAGED_EVENT = parseAbiItem(
  'event Deleveraged(uint256 assetAmountWithdrawn, uint256 borrowRepayAmount)',
);

export type VaultAssessment = {
  vault: LeverageYieldVault;
  collateral: bigint;
  debt: bigint;
  idleAsset: bigint;
  currentLTV: bigint;
  targetLTV: bigint;
  tolerance: bigint;
  deviation: bigint;
  healthFactor: bigint;
  needsRebalance: boolean;
};

export type TickEventName = 'Leveraged' | 'Deleveraged' | 'Rebalanced' | 'none';

export type TickOutcome =
  | { kind: 'skipped'; reason: 'within-tolerance' | 'dry-run' }
  // `reverted`: tick() simulation failed on-chain (e.g. HF floor) — expected, not paged on.
  // `errored`:  infrastructure/unexpected failure (RPC down, bad response) — systemic signal.
  | { kind: 'reverted'; error: string }
  | { kind: 'errored'; error: string }
  | {
      kind: 'ticked';
      txHash: Hash;
      blockNumber: bigint;
      gasUsed: bigint;
      eventName: TickEventName;
      solverNotified: boolean;
    };

export type VaultResult = VaultAssessment & {
  outcome: TickOutcome;
};

/** Build read-only public client + signer wallet client. */
export function buildClients(cfg: KeeperConfig): {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
} {
  const account = privateKeyToAccount(cfg.privateKey);
  const transport = http(cfg.sonicRpc);
  const publicClient = createPublicClient({ chain: sonic, transport });
  const walletClient = createWalletClient({ account, chain: sonic, transport });
  return { publicClient, walletClient, account };
}

/** Read all the inputs needed to decide whether a vault needs ticking. */
async function assess(
  vault: LeverageYieldVault,
  publicClient: PublicClient,
): Promise<VaultAssessment> {
  const [position, targetLTV, tolerance] = await Promise.all([
    publicClient.readContract({
      address: vault.address,
      abi: VAULT_ABI,
      functionName: 'getPositionDetails',
    }),
    publicClient.readContract({
      address: vault.address,
      abi: VAULT_ABI,
      functionName: 'targetLTV',
    }),
    publicClient.readContract({
      address: vault.address,
      abi: VAULT_ABI,
      functionName: 'ltvTolerance',
    }),
  ]);

  const [collateral, debt, currentLTV, healthFactor, idleAsset] = position;
  const deviation = currentLTV > targetLTV ? currentLTV - targetLTV : targetLTV - currentLTV;

  return {
    vault,
    collateral,
    debt,
    idleAsset,
    currentLTV,
    targetLTV,
    tolerance,
    deviation,
    healthFactor,
    needsRebalance: deviation > tolerance,
  };
}

/** Submit `tick()`, wait for receipt, decode events, optionally POST to solver. */
async function executeTick(
  vault: LeverageYieldVault,
  cfg: KeeperConfig,
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: Account,
): Promise<TickOutcome> {
  let txHash: Hash;
  try {
    // Simulate first — catches reverts (e.g. HF too low to lever up) without paying gas.
    // `simulateContract` is read-only (eth_call), so passing just `account.address` is fine
    // and matches viem's expected shape for the simulate path.
    await publicClient.simulateContract({
      address: vault.address,
      abi: VAULT_ABI,
      functionName: 'tick',
      account: account.address,
    });

    // For `writeContract` we need the full Account (with signing methods) so viem signs
    // locally and sends `eth_sendRawTransaction`. Passing just the address triggers
    // `eth_sendTransaction`, which the public Sonic RPC rejects with "unknown account".
    txHash = await walletClient.writeContract({
      address: vault.address,
      abi: VAULT_ABI,
      functionName: 'tick',
      account,
      chain: sonic,
    });
  } catch (e) {
    // viem errors carry `shortMessage` for the one-line summary, plus often a `cause` chain
    // ending in a `RawContractError` with raw revert data. Surface as much as we can — the
    // generic "Missing or invalid parameters" you see on top-level usually hides a real
    // revert reason or empty-revert downstream.
    return { kind: 'reverted', error: viemErrorToString(e) };
  }

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: cfg.tickTimeoutMs,
  });

  // Decode events. The vault emits at most one of (Leveraged | Deleveraged) per tick,
  // plus a Rebalanced for the LTV transition. We only POST to the solver on Leveraged
  // (that's the path that creates a swap intent for the solver to fill).
  let eventName: TickEventName = 'none';
  const lcVault = vault.address.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== lcVault) continue;
    try {
      const parsed = decodeEventLog({ abi: VAULT_ABI, data: log.data, topics: log.topics });
      if (parsed.eventName === 'Leveraged') {
        eventName = 'Leveraged';
        break;
      }
      if (parsed.eventName === 'Deleveraged') {
        eventName = 'Deleveraged';
      } else if (parsed.eventName === 'Rebalanced' && eventName === 'none') {
        eventName = 'Rebalanced';
      }
    } catch {
      // Not one of our events — skip.
    }
  }

  let solverNotified = false;
  if (eventName === 'Leveraged') {
    const res = await notifySolver(cfg.solverApiUrl, txHash);
    solverNotified = res.ok;
    log({
      level: res.ok ? 'info' : 'warn',
      vault: vault.name,
      msg: 'solver-notify',
      txHash,
      status: res.status,
      ok: res.ok,
      error: res.error,
    });
  }

  return {
    kind: 'ticked',
    txHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    eventName,
    solverNotified,
  };
}

/** Run one full keeper pass over every configured vault. */
export async function runKeeper(cfg: KeeperConfig): Promise<VaultResult[]> {
  const { publicClient, walletClient, account } = buildClients(cfg);
  log({
    level: 'info',
    msg: 'keeper-start',
    keeper: account.address,
    vaultCount: cfg.vaults.length,
    sonicRpc: cfg.sonicRpc,
  });

  const results: VaultResult[] = [];
  for (const vault of cfg.vaults) {
    try {
      const assessment = await assess(vault, publicClient);
      log({
        level: 'info',
        vault: vault.name,
        address: vault.address,
        msg: 'assess',
        collateral: assessment.collateral.toString(),
        debt: assessment.debt.toString(),
        idleAsset: assessment.idleAsset.toString(),
        currentLTV: assessment.currentLTV.toString(),
        targetLTV: assessment.targetLTV.toString(),
        tolerance: assessment.tolerance.toString(),
        deviation: assessment.deviation.toString(),
        healthFactor: assessment.healthFactor.toString(),
        needsRebalance: assessment.needsRebalance,
      });

      let outcome: TickOutcome;
      if (!assessment.needsRebalance) {
        outcome = { kind: 'skipped', reason: 'within-tolerance' };
      } else if (cfg.dryRun) {
        // Read-only mode: report that a tick *would* fire, but don't send it.
        outcome = { kind: 'skipped', reason: 'dry-run' };
      } else {
        outcome = await executeTick(vault, cfg, publicClient, walletClient, account);
      }

      log({
        level: outcome.kind === 'reverted' ? 'warn' : 'info',
        vault: vault.name,
        msg: 'tick-outcome',
        ...outcomeToLog(outcome),
      });

      results.push({ ...assessment, outcome });
    } catch (e) {
      log({
        level: 'error',
        vault: vault.name,
        msg: 'vault-error',
        error: e instanceof Error ? e.message : String(e),
      });
      results.push({
        vault,
        collateral: 0n,
        debt: 0n,
        idleAsset: 0n,
        currentLTV: 0n,
        targetLTV: 0n,
        tolerance: 0n,
        deviation: 0n,
        healthFactor: 0n,
        needsRebalance: false,
        outcome: { kind: 'errored', error: viemErrorToString(e) },
      });
    }
  }
  return results;
}

/**
 * Systemic-failure check for the Lambda entry. Returns true only when *every* vault hit an
 * infrastructure error (`kind: 'errored'` — RPC down, bad response), so the handler can
 * rethrow and surface a CloudWatch "Errors" invocation. A single vault erroring, or a tick
 * `reverted` (HF floor, paused — expected), does NOT trip this.
 */
export function isSystemicFailure(results: VaultResult[]): boolean {
  return results.length > 0 && results.every(r => r.outcome.kind === 'errored');
}

function outcomeToLog(outcome: TickOutcome): Record<string, unknown> {
  if (outcome.kind === 'skipped') return { kind: 'skipped', reason: outcome.reason };
  if (outcome.kind === 'reverted') return { kind: 'reverted', error: outcome.error };
  if (outcome.kind === 'errored') return { kind: 'errored', error: outcome.error };
  return {
    kind: 'ticked',
    txHash: outcome.txHash,
    blockNumber: outcome.blockNumber.toString(),
    gasUsed: outcome.gasUsed.toString(),
    eventName: outcome.eventName,
    solverNotified: outcome.solverNotified,
  };
}

/** Structured JSON log line. CloudWatch indexes the fields out of the box. */
function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

/**
 * Walk a viem error chain to surface as much detail as possible. viem nests:
 *   ContractFunctionExecutionError → ContractFunctionRevertedError → RawContractError
 * For empty-revert tx() reverts the top-level message is just "Missing or invalid
 * parameters" — the useful info is buried in `metaMessages`, `details`, or `data`.
 */
function viemErrorToString(e: unknown): string {
  if (!e || typeof e !== 'object') return String(e);
  const err = e as {
    shortMessage?: string;
    metaMessages?: string[];
    details?: string;
    data?: { errorName?: string; args?: unknown };
    cause?: unknown;
    message?: string;
  };

  const parts: string[] = [];
  if (typeof err.shortMessage === 'string') parts.push(err.shortMessage);
  if (Array.isArray(err.metaMessages) && err.metaMessages.length > 0) {
    parts.push(err.metaMessages.join(' | '));
  }
  if (typeof err.details === 'string' && !parts.join(' ').includes(err.details)) {
    parts.push(`details: ${err.details}`);
  }
  if (err.data?.errorName) {
    parts.push(`revert: ${err.data.errorName}(${JSON.stringify(err.data.args ?? [])})`);
  }
  if (err.cause && err.cause !== e) {
    const causeStr = viemErrorToString(err.cause);
    if (causeStr && !parts.join(' ').includes(causeStr)) parts.push(`cause: ${causeStr}`);
  }
  if (parts.length === 0 && typeof err.message === 'string') parts.push(err.message);
  return parts.join(' — ') || String(e);
}

// Suppress unused lint on the deleveraged event helper — kept for future event coverage.
void DELEVERAGED_EVENT;
void LEVERAGED_EVENT;
