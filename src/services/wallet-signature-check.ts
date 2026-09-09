/**
 * wallet-signature-check.ts — pre-live wallet configuration validation.
 *
 * Adopted from pmxt core/src/exchanges/polymarket/auth.ts:15-20 (signature
 * types) with the CORRECTED stance: never silently fall back to EOA or
 * Gnosis on uncertain discovery — an unknown signature type is a hard
 * config error that live mode must refuse.
 *
 * Signature types (Polymarket): 0 = EOA, 1 = proxy, 2 = Gnosis Safe,
 * 3 = ERC-1271 deposit wallet.
 */

export interface WalletConfig {
  /** Wallet that signs orders (EOA or the signer behind a proxy/gateway). */
  signerAddress?: string;
  /** Wallet that holds the collateral / is authorized to fund (proxy-owner). */
  funderAddress?: string;
  /** Polymarket signature type: 0 EOA, 1 proxy, 2 Gnosis, 3 ERC-1271. */
  signatureType?: number;
  /** The Polymarket proxy address (signatureType === 1). */
  proxyAddress?: string;
  /** Expected chain id (Polymarket = Polygon = 137). */
  chainId?: number;
}

const VALID_TYPES = new Set([0, 1, 2, 3]);

/** Return human-readable config problems (empty = valid). */
export function validateWalletConfig(cfg: WalletConfig): string[] {
  const problems: string[] = [];
  const signer = cfg.signerAddress ?? '';
  const funder = cfg.funderAddress ?? '';
  const type = cfg.signatureType ?? -1;
  if (!/^0x[a-fA-F0-9]{40}$/.test(signer)) problems.push(`signerAddress must be a valid 0x address, got "${signer}"`);
  if (!/^0x[a-fA-F0-9]{40}$/.test(funder)) problems.push(`funderAddress must be a valid 0x address, got "${funder}"`);
  if (!VALID_TYPES.has(type)) problems.push(`signatureType ${type} is unknown — must be 0 (EOA), 1 (proxy), 2 (Gnosis), 3 (ERC-1271); refusing to guess`);
  if (cfg.chainId !== undefined && cfg.chainId !== 137) problems.push(`chainId ${cfg.chainId} is not Polygon (137) — Polymarket expects 137`);
  if (type === 0 && signer && funder && signer.toLowerCase() !== funder.toLowerCase()) {
    problems.push('signatureType 0 (EOA): funderAddress must equal signerAddress');
  }
  if (type === 1) {
    const proxy = cfg.proxyAddress ?? '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(proxy)) problems.push('signatureType 1 (proxy): proxyAddress is required');
    else if (funder && funder.toLowerCase() !== proxy.toLowerCase()) problems.push('signatureType 1 (proxy): funderAddress must equal proxyAddress');
  }
  if (type === 2 && funder && signer && funder.toLowerCase() !== signer.toLowerCase()) {
    problems.push('signatureType 2 (Gnosis): funder should equal the safe address (signer)');
  }
  return problems;
}

/** Throw on the first problem — live mode must refuse to boot. */
export function assertValidWalletConfig(cfg: WalletConfig): void {
  const problems = validateWalletConfig(cfg);
  if (problems.length > 0) throw new Error(`invalid wallet config: ${problems.join('; ')}`);
}