// Side-effect module: the CLI entry imports it right after exeSearchGuard, so
// the console streams are settled before any module can print or keep a
// reference to process.stdout/stderr (see consoleStdio.ts).
import { routeConsoleStdio } from './consoleStdio';

routeConsoleStdio();
