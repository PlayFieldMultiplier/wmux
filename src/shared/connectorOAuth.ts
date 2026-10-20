/** OAuth status only. Tokens and authorization codes never cross renderer IPC. */
export const CONNECTOR_OAUTH_IPC = 'connectors:oauth';
export type ConnectorOAuthAction = 'status' | 'approve' | 'connect' | 'disconnect' | 'cancel';
export type ConnectorOAuthStatus = 'signed-out' | 'confirm' | 'authorizing' | 'authorized' | 'expired' | 'failed' | 'unavailable' | 'busy';
export interface ConnectorOAuthResult { status: ConnectorOAuthStatus; consent?: { id: string; resource: string; issuer: string; authorizationOrigin: string } }
