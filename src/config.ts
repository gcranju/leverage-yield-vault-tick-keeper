/**
 * Vault registry + env loading for the keeper.
 *
 * The vault list is local to this repo (intentionally — keepers should be decoupled
 * from SDK release cycles). Mirror new entries from `@sodax/types`'s `leverageYieldVaults`
 * when a new vault is promoted to a default. Override per-deployment via the `VAULTS`
 * env var (comma-separated addresses) — useful for testnet / staging vaults that aren't
 * (yet) in the canonical registry.
 */

import type { Address } from 'viem';

export type LeverageYieldVault = {
  /** Stable lookup key, used in logs. */
  name: string;
  /** Deployed `LeverageYieldVault` proxy address on Sonic. */
  address: Address;
};

/** Built-in registry. Edit when a new vault is deployed and ready for production keeping. */
export const REGISTRY: readonly LeverageYieldVault[] = [
  {
    name: 'weETH-leveraged',
    address: '0xD09de2f5070699A909c0FD32fb5A909d3886701D',
  },
];

export type KeeperConfig = {
  privateKey: `0x${string}`;
  sonicRpc: string;
  solverApiUrl: string;
  vaults: readonly LeverageYieldVault[];
  tickTimeoutMs: number;
};

/**
 * Resolve config from process.env. Throws on missing required fields so the Lambda
 * cold-start fails fast rather than silently no-opping every minute.
 */
export function loadConfig(): KeeperConfig {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey || !privateKey.startsWith('0x')) {
    throw new Error('PRIVATE_KEY missing or not 0x-prefixed');
  }

  const sonicRpc = process.env.SONIC_RPC ?? 'https://rpc.soniclabs.com';
  const solverApiUrl = process.env.SOLVER_API_URL ?? 'https://api.sodax.com';
  const tickTimeoutMs = Number.parseInt(process.env.TICK_TIMEOUT_MS ?? '60000', 10);

  // Override path: explicit address allow-list. Names are derived from the position
  // in the list — if you need real names for ad-hoc vaults, add them to REGISTRY instead.
  const overrideRaw = process.env.VAULTS?.trim();
  const vaults: readonly LeverageYieldVault[] = overrideRaw
    ? overrideRaw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map((address, i) => ({ name: `vault-${i}`, address: address as Address }))
    : REGISTRY;

  if (vaults.length === 0) {
    throw new Error('No vaults configured (REGISTRY empty AND VAULTS env unset)');
  }

  return {
    privateKey: privateKey as `0x${string}`,
    sonicRpc,
    solverApiUrl,
    vaults,
    tickTimeoutMs,
  };
}
