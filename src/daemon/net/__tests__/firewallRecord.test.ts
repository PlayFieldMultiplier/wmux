import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FirewallRecordStore } from '../firewallRecord';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fwrec-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('FirewallRecordStore', () => {
  it('records, reads back and forgets one listener without touching another', () => {
    const store = new FirewallRecordStore(dir);
    expect(store.get('a2a')).toBeNull();
    expect(store.set({ listener: 'a2a', id: 'wmux-a2a-1a2b3c4d', port: 45660, exe: 'C:\\w\\app-1.0.0\\wmux.exe', createdAt: 5 })).toBe(true);
    expect(store.set({ listener: 'web', id: 'wmux-web-1a2b3c4d', port: 7681, exe: 'C:\\w\\app-1.0.0\\wmux.exe', createdAt: 6 })).toBe(true);
    expect(new FirewallRecordStore(dir).get('a2a')).toEqual({ listener: 'a2a', id: 'wmux-a2a-1a2b3c4d', port: 45660, exe: 'C:\\w\\app-1.0.0\\wmux.exe', createdAt: 5 });
    expect(store.clear('a2a')).toBe(true);
    expect(store.get('a2a')).toBeNull();
    expect(store.get('web')?.port).toBe(7681);
  });

  it('a missing or malformed file reads as nothing recorded', () => {
    const store = new FirewallRecordStore(dir);
    fs.writeFileSync(path.join(dir, 'firewall-rules.json'), '{not json');
    expect(store.get('a2a')).toBeNull();
    fs.writeFileSync(path.join(dir, 'firewall-rules.json'), JSON.stringify({ version: 1, rules: { a2a: { id: 1 }, bogus: { id: 'x', port: 1, exe: 'x', createdAt: 1 } } }));
    expect(store.get('a2a')).toBeNull();
    expect(store.clear('lanlink')).toBe(true);
  });
});
