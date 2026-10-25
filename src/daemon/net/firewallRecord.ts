// === firewall-rules.json: which rules a Fix confirmed, for which program ===
//
// The probe looks up rules by program (one fast query). When wmux updates,
// Squirrel moves the exe to a new app-X.Y.Z folder and the old rule stops
// matching; the by-program query then finds nothing, exactly as if no rule
// had ever been made. This record tells the two apart ("wmux was updated;
// allow the new version again" vs "no firewall rule allows port N") without a
// 1-2 s scan of every rule by name or group.
//
// Written by main through `net.firewallRecord` only after a re-probe
// confirmed the rule, and cleared after a confirmed Remove. It can drift (a
// rule deleted in wf.msc); the probe treats "recorded for this exe but
// absent" as not covered, and the next Fix rewrites it.
//
// Imports node builtins and shared types only.

import fs from 'node:fs';
import path from 'node:path';
import { isFirewallListener, type FirewallListener } from '../../shared/netFirewall';

export interface FirewallRuleRecord {
  listener: FirewallListener;
  /** The rule ID base (`wmux-a2a-1a2b3c4d`). */
  id: string;
  port: number;
  /** The program path the rule names. */
  exe: string;
  /** Epoch ms. */
  createdAt: number;
}

const FILE = 'firewall-rules.json';

function coerce(listener: FirewallListener, v: unknown): FirewallRuleRecord | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || typeof o['exe'] !== 'string' || typeof o['port'] !== 'number' || typeof o['createdAt'] !== 'number') return null;
  return { listener, id: o['id'], port: o['port'], exe: o['exe'], createdAt: o['createdAt'] };
}

export class FirewallRecordStore {
  private readonly file: string;

  constructor(wmuxDir: string) {
    this.file = path.join(wmuxDir, FILE);
  }

  private readAll(): Partial<Record<FirewallListener, FirewallRuleRecord>> {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const rules = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['rules'] : null;
      const out: Partial<Record<FirewallListener, FirewallRuleRecord>> = {};
      if (rules && typeof rules === 'object') {
        for (const [k, v] of Object.entries(rules as Record<string, unknown>)) {
          if (!isFirewallListener(k)) continue;
          const rec = coerce(k, v);
          if (rec) out[k] = rec;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  private writeAll(rules: Partial<Record<FirewallListener, FirewallRuleRecord>>): boolean {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const body: Record<string, Omit<FirewallRuleRecord, 'listener'>> = {};
      for (const [k, r] of Object.entries(rules)) {
        if (r) body[k] = { id: r.id, port: r.port, exe: r.exe, createdAt: r.createdAt };
      }
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, rules: body }, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing was written */
      }
      return false;
    }
  }

  get(listener: FirewallListener): FirewallRuleRecord | null {
    return this.readAll()[listener] ?? null;
  }

  set(record: FirewallRuleRecord): boolean {
    const all = this.readAll();
    all[record.listener] = record;
    return this.writeAll(all);
  }

  clear(listener: FirewallListener): boolean {
    const all = this.readAll();
    if (!all[listener]) return true;
    delete all[listener];
    return this.writeAll(all);
  }
}
