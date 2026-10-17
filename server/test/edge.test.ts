import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { checkPass, issueToken, readToken } from '../src/services/gateway/edge';

const req = (headers: Record<string, string>) => ({ headers, ip: '127.0.0.1' }) as unknown as FastifyRequest;

describe('session tokens', () => {
  it('round-trip', () => {
    const { token, userId } = issueToken();
    const ident = readToken(req({ authorization: `Bearer ${token}` }));
    expect(ident?.userId).toBe(userId);
    expect(Date.now() - ident!.issuedAt).toBeLessThan(1000);
  });

  it('reject tampering', () => {
    const { token } = issueToken();
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(`u_attacker.${Date.now() - 60_000}`).toString('base64url');
    expect(readToken(req({ authorization: `Bearer ${forged}.${sig}` }))).toBeNull();
    expect(readToken(req({ authorization: `Bearer ${payload}.${sig.slice(0, -2)}xx` }))).toBeNull();
    expect(readToken(req({ authorization: 'Bearer garbage' }))).toBeNull();
    expect(readToken(req({}))).toBeNull();
  });
});

describe('waiting room pass', () => {
  it('rejects a missing or forged pass', () => {
    expect(() => checkPass(req({}), 'u_1')).toThrow(/queue/);
    expect(() => checkPass(req({ 'x-queue-pass': 'abc.def' }), 'u_1')).toThrow(/queue/);
  });
});
