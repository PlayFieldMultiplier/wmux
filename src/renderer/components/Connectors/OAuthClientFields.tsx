import { useT } from '../../hooks/useT';
import Input from '../ui/Input';
import type { ConnectorOAuthClient } from '../../../shared/connectorOAuth';

export function initialOAuthClient(endpoint: string): ConnectorOAuthClient {
  const google = /^https:\/\/(?:gmailmcp|calendarmcp|drivemcp|docsmcp|sheetsmcp|slidesmcp|chatmcp|people|classroommcp)\.googleapis\.com\/mcp\/v1$/.test(endpoint);
  const slack = endpoint === 'https://mcp.slack.com/mcp';
  return {
    clientId: '', clientSecret: '', callbackPort: 42813, tokenAuthMethod: 'client_secret_post',
    issuer: google ? 'https://accounts.google.com' : slack ? 'https://mcp.slack.com' : '',
    tokenEndpoint: google ? 'https://oauth2.googleapis.com/token' : slack ? 'https://slack.com/api/oauth.v2.user.access' : '',
    offlineAccess: google,
  };
}
export default function OAuthClientFields({ value, onChange }: { value: ConnectorOAuthClient; onChange: (value: ConnectorOAuthClient) => void }) {
  const t = useT();
  const update = (key: keyof ConnectorOAuthClient, next: string | number | boolean) => onChange({ ...value, [key]: next });
  return <div className="flex w-full flex-col gap-2">
    <p>{t('connectors.oauth.clientHint')}</p>
    {(['clientId', 'clientSecret', 'issuer', 'tokenEndpoint', 'scope'] as const).map((key) => <label key={key}>
      {t(`connectors.oauth.${key}`)}
      <Input type={key === 'clientSecret' ? 'password' : 'text'} autoComplete="off" spellCheck={false} maxLength={key === 'scope' || key === 'clientSecret' ? 4096 : 2048}
        value={value[key] ?? ''} onChange={(e) => update(key, e.target.value)} />
    </label>)}
    <label>{t('connectors.oauth.callbackPort')}<Input type="number" min={1024} max={65535} value={value.callbackPort} onChange={(e) => update('callbackPort', Number(e.target.value))} /></label>
    <p className="break-all font-mono">{`http://127.0.0.1:${value.callbackPort}/oauth/callback`}</p>
    <label>{t('connectors.oauth.tokenAuthMethod')}<select value={value.tokenAuthMethod} onChange={(e) => update('tokenAuthMethod', e.target.value)} className="ml-2 bg-[var(--bg-surface)]">
      <option value="client_secret_post">client_secret_post</option><option value="client_secret_basic">client_secret_basic</option><option value="none">none (PKCE)</option>
    </select></label>
    <label><input type="checkbox" checked={value.offlineAccess ?? false} onChange={(e) => update('offlineAccess', e.target.checked)} /> {t('connectors.oauth.offlineAccess')}</label>
  </div>;
}
