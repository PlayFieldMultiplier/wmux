// The bots of one workspace (or every workspace), read through the factory
// bot port and re-read on every bot change it reports. With no bot runtime
// the list stays empty.
import { useEffect, useState } from 'react';
import { getFactoryBotPort, type FactoryBotPort, type FactoryBotRow } from './factoryPorts';

const EMPTY: FactoryBotRow[] = [];

export function useFactoryBots(workspaceId: string | null, port?: FactoryBotPort): FactoryBotRow[] {
  const [rows, setRows] = useState<FactoryBotRow[]>(EMPTY);
  useEffect(() => {
    const p = port ?? getFactoryBotPort();
    if (!p.available) {
      setRows(EMPTY);
      return;
    }
    let live = true;
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      p.list(workspaceId ?? undefined).then(
        (next) => { if (live && mine === seq) setRows(next); },
        () => undefined,
      );
    };
    load();
    const off = p.subscribe(load);
    return () => {
      live = false;
      off();
    };
  }, [workspaceId, port]);
  return rows;
}
