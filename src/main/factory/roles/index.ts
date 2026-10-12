// The role reads and Moa's plan (pr.read, issue.read, ci.read, verdict.read,
// trustMetrics.read, plan.propose — shared/botSurface.ts). Registered here
// with registerFactoryRpcModule (../factoryHost.ts); while this file registers
// nothing, each answers not_implemented.
export {};
