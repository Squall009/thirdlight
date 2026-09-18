/**
 * ID syntax constants + validators (sessions.md §3; commands.md §3).
 */
import { describe, expect, it } from 'vitest';
import {
  CONN_ID_RE,
  NONCE_RE,
  PLAY_SESSION_ID_RE,
  PROJECT_ID_RE,
  RELAY_ID_RE,
  REQUEST_ID_RE,
  SESSION_ID_RE,
  SESSION_KINDS,
  WSTOKEN_RE,
  isConnId,
  isNonce,
  isPlaySessionId,
  isProjectId,
  isRelayId,
  isRequestId,
  isSessionId,
  isWsToken,
} from './ids';

const hex32 = '0123456789abcdef0123456789abcdef';
const hex64 = `${hex32}${hex32}`;

describe('ID syntax (sessions.md §3)', () => {
  it('sessionId: sess- + 32 lowercase hex', () => {
    expect(SESSION_ID_RE.test(`sess-${hex32}`)).toBe(true);
    expect(SESSION_ID_RE.test(`sess-${hex32.toUpperCase()}`)).toBe(false);
    expect(SESSION_ID_RE.test(`sess-${hex32.slice(0, 31)}`)).toBe(false);
    expect(SESSION_ID_RE.test(`sessX${hex32}`)).toBe(false);
    expect(isSessionId(`sess-${hex32}`)).toBe(true);
    expect(isSessionId(`sess-${hex32}`.toUpperCase())).toBe(false);
    expect(isSessionId(42)).toBe(false);
  });

  it('connId / playSessionId / relayId: prefix + 32 lowercase hex', () => {
    expect(CONN_ID_RE.test(`conn-${hex32}`)).toBe(true);
    expect(CONN_ID_RE.test(`conn-${hex32.slice(0, 31)}Z`)).toBe(false);
    expect(PLAY_SESSION_ID_RE.test(`play-${hex32}`)).toBe(true);
    expect(PLAY_SESSION_ID_RE.test(`conn-${hex32}`)).toBe(false);
    expect(RELAY_ID_RE.test(`relay-${hex32}`)).toBe(true);
    expect(RELAY_ID_RE.test(`relay-${hex32}0`)).toBe(false);
    expect(isConnId(`conn-${hex32}`)).toBe(true);
    expect(isPlaySessionId(`play-${hex32}`)).toBe(true);
    expect(isRelayId(`relay-${hex32}`)).toBe(true);
    expect(isPlaySessionId(`play-`)).toBe(false);
  });

  it('wsToken: exactly 64 lowercase hex', () => {
    expect(WSTOKEN_RE.test(hex64)).toBe(true);
    expect(WSTOKEN_RE.test(hex64.slice(0, 63))).toBe(false);
    expect(WSTOKEN_RE.test(`sess-${hex32}`)).toBe(false);
    expect(isWsToken(hex64)).toBe(true);
    expect(isWsToken(hex64.slice(0, 64 - 1))).toBe(false);
  });

  it('requestId: req- + 32 hex (commands.md §3)', () => {
    expect(REQUEST_ID_RE.test(`req-${hex32}`)).toBe(true);
    expect(REQUEST_ID_RE.test(`req-${hex32}0`)).toBe(false);
    expect(isRequestId(`req-${hex32}`)).toBe(true);
    expect(isRequestId('tb-req-0123')).toBe(false);
  });

  it('project ID: project-model §5.1 syntax', () => {
    expect(PROJECT_ID_RE.test('demo-0001')).toBe(true);
    expect(PROJECT_ID_RE.test('a_b-c9')).toBe(true);
    expect(PROJECT_ID_RE.test('_lead')).toBe(false);
    expect(PROJECT_ID_RE.test('UPPER')).toBe(false);
    expect(PROJECT_ID_RE.test('x'.repeat(66))).toBe(false);
    expect(isProjectId('demo-0001')).toBe(true);
    expect(isProjectId(7)).toBe(false);
  });

  it('nonce: 16 lowercase hex', () => {
    expect(NONCE_RE.test(hex32.slice(0, 16))).toBe(true);
    expect(NONCE_RE.test(hex32.slice(0, 15))).toBe(false);
    expect(isNonce('ABCDEF0123456789')).toBe(false);
  });

  it('session kinds: exactly "browser" (M1)', () => {
    expect(SESSION_KINDS).toEqual(['browser']);
  });
});