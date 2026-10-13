import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
if (!process.argv[2]) throw new Error('Usage: node scripts/rust-output-interpreter-bench.mjs OUTPUT.json');
const report = path.resolve(process.argv[2]);
if (fs.existsSync(report)) throw new Error('Choose a new report filename');
const temporary = fs.mkdtempSync(path.join(root, '.native-interpreter-bench-'));
try {
  const worker = path.join(temporary, 'bench.cjs');
  await build({stdin:{contents:"import { benchmarkOutputInterpreter } from './bench/output-interpreter-bench'; console.log(JSON.stringify(benchmarkOutputInterpreter(), null, 2));",resolveDir:root,loader:'ts'},outfile:worker,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  const result = execFileSync(process.execPath, [worker], {cwd:root,encoding:'utf8',timeout:60000,
    env:{...process.env,WMUX_TERMINAL_CORE_MODULE:path.join(root,'core/wmux-term/dist/native-core/index.cjs')}});
  fs.writeFileSync(report,result,{flag:'wx'});
  process.stdout.write(result);
} finally {fs.rmSync(temporary,{recursive:true,force:true});}
