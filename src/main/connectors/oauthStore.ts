import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SecretCrypto } from '../factory/secretStore';
import { CONNECTOR_ID_RE } from '../../shared/botConnector';

export interface OAuthRecord {
  endpoint: string;
  redirectUrl: string;
  client: OAuthClientInformationMixed;
  tokens: OAuthTokens;
  expiresAt: number;
}
/** One encrypted record per connection. No plaintext fallback or shared token file. */
export class ConnectorOAuthStore {
  constructor(private directory: string, private crypto: SecretCrypto) {}
  private file(id: string) {
    if (!CONNECTOR_ID_RE.test(id)) throw new Error('Invalid connection');
    return path.join(this.directory, `${id}.json`);
  }
  available(): boolean { return this.crypto.state() === 'ok'; }
  read(id: string, endpoint: string): OAuthRecord | undefined {
    if (!this.available()) throw new Error('Secure storage unavailable');
    let cipher: Buffer;
    try { cipher = fs.readFileSync(this.file(id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Cannot read authorization'); }
    if (cipher.length > 256 * 1024) throw new Error('Invalid authorization record');
    const record = JSON.parse(this.crypto.decrypt(cipher)) as OAuthRecord;
    if (record.endpoint !== endpoint) return undefined;
    if (!record.client?.client_id || !record.tokens?.access_token || !record.tokens.issuer || !Number.isFinite(record.expiresAt)) throw new Error('Invalid authorization record');
    return record;
  }
  ids(): string[] {
    try { return fs.readdirSync(this.directory).filter((name) => name.endsWith('.json') && CONNECTOR_ID_RE.test(name.slice(0, -5))).map((name) => name.slice(0, -5)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  write(id: string, record: OAuthRecord): void {
    if (!this.available()) throw new Error('Secure storage unavailable');
    const target = this.file(id);
    const cipher = this.crypto.encrypt(JSON.stringify(record));
    if (cipher.length > 256 * 1024) throw new Error('Authorization too large');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const tmp = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    try { fs.writeFileSync(tmp, cipher, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, target); }
    finally { try { fs.unlinkSync(tmp); } catch { /* renamed or never created */ } }
  }
  remove(id: string): void { fs.rmSync(this.file(id), { force: true }); }
}
