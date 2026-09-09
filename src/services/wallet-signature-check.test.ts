import { describe, it, expect } from 'vitest';
import { validateWalletConfig, assertValidWalletConfig } from './wallet-signature-check.js';

const OK = { signerAddress: '0x1111111111111111111111111111111111111111', funderAddress: '0x1111111111111111111111111111111111111111', signatureType: 0, chainId: 137 };

describe('validateWalletConfig (pmxt auth.ts patterns)', () => {
  it('accepts a consistent EOA config', () => {
    expect(validateWalletConfig(OK)).toEqual([]);
  });
  it('flags a funder that differs from the signer for EOA', () => {
    const problems = validateWalletConfig({ ...OK, funderAddress: '0x2222222222222222222222222222222222222222' });
    expect(problems.some((p) => p.includes('funder'))).toBe(true);
  });
  it('accepts a proxy config where funder == proxyAddress', () => {
    const problems = validateWalletConfig({ ...OK, signatureType: 1, funderAddress: '0x9999999999999999999999999999999999999999', proxyAddress: '0x9999999999999999999999999999999999999999' });
    expect(problems).toEqual([]);
  });
  it('flags a proxy config whose funder is NOT the proxy', () => {
    const problems = validateWalletConfig({ ...OK, signatureType: 1, funderAddress: '0x3333333333333333333333333333333333333333', proxyAddress: '0x9999999999999999999999999999999999999999' });
    expect(problems.some((p) => p.includes('proxy'))).toBe(true);
  });
  it('flags ambiguous/unknown signature types (never silently fall back)', () => {
    expect(validateWalletConfig({ ...OK, signatureType: undefined as unknown as number })).not.toEqual([]);
    expect(validateWalletConfig({ ...OK, signatureType: 99 })).not.toEqual([]);
  });
  it('flags a wrong chainId for Polymarket (Polygon = 137)', () => {
    expect(validateWalletConfig({ ...OK, chainId: 1 })).not.toEqual([]);
  });
  it('requires non-empty addresses', () => {
    expect(validateWalletConfig({ ...OK, signerAddress: '0x' })).not.toEqual([]);
    expect(validateWalletConfig({ ...OK, funderAddress: '0x' })).not.toEqual([]);
  });
});

describe('assertValidWalletConfig', () => {
  it('throws on problems, passes clean config', () => {
    expect(() => assertValidWalletConfig({ ...OK, signatureType: 99 })).toThrow();
    expect(() => assertValidWalletConfig(OK)).not.toThrow();
  });
});