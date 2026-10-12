// The factory's main-process modules, imported once by main/index.ts. Each
// file registers itself with registerFactoryRpcModule (./factoryHost.ts) at
// import time; a factory RPC method none of them registers answers
// not_implemented.
import '../pipe/handlers/fact.rpc';
import '../pipe/handlers/bot.rpc';
import './triggerEngine';
import '../pipe/handlers/room.rpc';
import '../pipe/handlers/handoff.rpc';
import './roles';
import './mergeLaneHost';
