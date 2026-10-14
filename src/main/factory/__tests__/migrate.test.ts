import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FACTORY_MIGRATION_STEPS,
  factoryMigrationMarkerPath,
  readFactoryMigrationVersion,
  runFactoryMigrations,
  type FactoryMigrationStep,
} from '../migrate';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-factory-migrate-'));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('runFactoryMigrations', () => {
  it('an empty chain is a no-op that writes nothing', () => {
    expect(runFactoryMigrations(dir, { steps: [] })).toEqual({ from: 0, to: 0, notes: [] });
    expect(fs.existsSync(factoryMigrationMarkerPath(dir))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'factory'))).toBe(false);
  });

  it('the shipped chain runs on a fresh data dir and then is a no-op', () => {
    const n = FACTORY_MIGRATION_STEPS.length;
    expect(runFactoryMigrations(dir)).toEqual({ from: 0, to: n, notes: [] });
    expect(readFactoryMigrationVersion(dir)).toBe(n);
    expect(runFactoryMigrations(dir)).toEqual({ from: n, to: n, notes: [] });
  });

  it('walks the steps once, records the version, and is idempotent', () => {
    let runs = 0;
    const steps: FactoryMigrationStep[] = [{
      fromVersion: 0,
      toVersion: 1,
      migrate: (ctx) => {
        runs += 1;
        fs.writeFileSync(path.join(ctx.factoryDir, 'settings.json'), '{}');
        ctx.notes.push('settings written');
        return ctx;
      },
    }];
    expect(runFactoryMigrations(dir, { steps, now: 5 })).toEqual({ from: 0, to: 1, notes: ['settings written'] });
    expect(readFactoryMigrationVersion(dir)).toBe(1);
    expect(runFactoryMigrations(dir, { steps })).toEqual({ from: 1, to: 1, notes: [] });
    expect(runs).toBe(1);
  });

  it('a later step runs on a machine that already ran the earlier one', () => {
    const order: number[] = [];
    const step = (n: number): FactoryMigrationStep => ({ fromVersion: n, toVersion: n + 1, migrate: (ctx) => { order.push(n); return ctx; } });
    runFactoryMigrations(dir, { steps: [step(0)] });
    runFactoryMigrations(dir, { steps: [step(0), step(1)] });
    expect(order).toEqual([0, 1]);
    expect(readFactoryMigrationVersion(dir)).toBe(2);
  });

  it('a failing step leaves the marker where it was', () => {
    const steps: FactoryMigrationStep[] = [{ fromVersion: 0, toVersion: 1, migrate: () => { throw new Error('disk'); } }];
    expect(() => runFactoryMigrations(dir, { steps })).toThrow(/disk/);
    expect(readFactoryMigrationVersion(dir)).toBe(0);
  });

  it('refuses an unreadable marker instead of guessing a version', () => {
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    fs.writeFileSync(factoryMigrationMarkerPath(dir), JSON.stringify({ version: 'one' }));
    expect(() => readFactoryMigrationVersion(dir)).toThrow(/unreadable/);
  });
});
