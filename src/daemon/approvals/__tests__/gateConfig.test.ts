// #1939 — Claude's PowerShell tool joins the gate defaults, and a one-time
// migration adds it to a stored list wherever Bash is gated.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GATED_TOOLS,
  coerceGate,
  createDefaultGateConfig,
  migrateGateForPowerShell,
} from '../gateConfig';

describe('gate defaults (#1939)', () => {
  it('gate PowerShell alongside Bash', () => {
    expect(DEFAULT_GATED_TOOLS).toContain('Bash');
    expect(DEFAULT_GATED_TOOLS).toContain('PowerShell');
    expect(createDefaultGateConfig().gatedTools).toContain('PowerShell');
    // Absent or malformed slice falls back to the defaults, PowerShell included.
    expect(coerceGate(undefined).gatedTools).toContain('PowerShell');
    expect(coerceGate({ gatedTools: 'Bash' }).gatedTools).toContain('PowerShell');
  });
});

describe('migrateGateForPowerShell (#1939)', () => {
  it('inserts PowerShell right after Bash and keeps every other entry', () => {
    expect(migrateGateForPowerShell({ gatedTools: ['Write', 'Bash', 'WebFetch'] }))
      .toEqual({ gatedTools: ['Write', 'Bash', 'PowerShell', 'WebFetch'] });
  });

  it('keeps other fields of the slice', () => {
    expect(migrateGateForPowerShell({ gatedTools: ['Bash'], extra: 1 }))
      .toEqual({ gatedTools: ['Bash', 'PowerShell'], extra: 1 });
  });

  it('does not touch a list that does not gate Bash, including the empty "gate off" list', () => {
    const noBash = { gatedTools: ['Write', 'Edit'] };
    expect(migrateGateForPowerShell(noBash)).toBe(noBash);
    const off = { gatedTools: [] };
    expect(migrateGateForPowerShell(off)).toBe(off);
    // Matching is exact in HookIngest, so a lowercase `bash` never gated anything.
    const lower = { gatedTools: ['bash'] };
    expect(migrateGateForPowerShell(lower)).toBe(lower);
  });

  it('is idempotent when PowerShell is already there', () => {
    const both = { gatedTools: ['PowerShell', 'Bash'] };
    expect(migrateGateForPowerShell(both)).toBe(both);
  });

  it('leaves an absent or malformed slice for coerceGate to handle', () => {
    expect(migrateGateForPowerShell(undefined)).toBeUndefined();
    expect(migrateGateForPowerShell(null)).toBeNull();
    expect(migrateGateForPowerShell('Bash')).toBe('Bash');
    const arr = ['Bash'];
    expect(migrateGateForPowerShell(arr)).toBe(arr);
    const badTools = { gatedTools: 'Bash' };
    expect(migrateGateForPowerShell(badTools)).toBe(badTools);
  });

  it('does not mutate the stored array', () => {
    const tools = ['Bash'];
    migrateGateForPowerShell({ gatedTools: tools });
    expect(tools).toEqual(['Bash']);
  });
});
