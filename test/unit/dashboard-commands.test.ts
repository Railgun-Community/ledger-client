/**
 * Tests for dashboard APDU command builders.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDashboardGetVersion,
  buildGetAppAndVersion,
  buildOpenApp,
  buildCloseApp,
  buildListApps,
} from '../../src/core/transport/dashboard-commands.js';

describe('dashboard commands', () => {
  it('buildDashboardGetVersion', () => {
    const cmd = buildDashboardGetVersion();
    expect(cmd.cla).toBe(0xe0);
    expect(cmd.ins).toBe(0x01);
    expect(cmd.p1).toBe(0x00);
    expect(cmd.p2).toBe(0x00);
    expect(cmd.data).toBeUndefined();
  });

  it('buildGetAppAndVersion', () => {
    const cmd = buildGetAppAndVersion();
    expect(cmd.cla).toBe(0xb0);
    expect(cmd.ins).toBe(0x01);
  });

  it('buildOpenApp encodes app name as data', () => {
    const cmd = buildOpenApp('Ethereum');
    expect(cmd.cla).toBe(0xe0);
    expect(cmd.ins).toBe(0xd8);
    expect(cmd.data).toBeDefined();
    const decoded = new TextDecoder().decode(cmd.data);
    expect(decoded).toBe('Ethereum');
  });

  it('buildCloseApp', () => {
    const cmd = buildCloseApp();
    expect(cmd.cla).toBe(0xb0);
    expect(cmd.ins).toBe(0xa7);
  });

  it('buildListApps initial request has p1=0', () => {
    const cmd = buildListApps(false);
    expect(cmd.cla).toBe(0xe0);
    expect(cmd.ins).toBe(0xde);
    expect(cmd.p1).toBe(0x00);
  });

  it('buildListApps continued request uses INS 0xDF', () => {
    const cmd = buildListApps(true);
    expect(cmd.ins).toBe(0xdf);
    expect(cmd.p1).toBe(0x00);
  });
});
