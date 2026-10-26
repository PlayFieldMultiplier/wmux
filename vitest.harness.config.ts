import { defineConfig } from 'vitest/config';
import { hashbangLf } from './scripts/lib/vitest-hashbang-lf.mjs';

// E0 컨포먼스 하니스 레인 (스펙 §5-1·§5-2). 기존 세 레인(test:parallel·test:runtime·test:rig)과
// 완전히 분리된 네 번째 레인. include 글롭이 core/harness/의 `*.harness.test.ts`만 잡으므로
// 기존 레인(src/**/__tests__/**, rig/**/*.rig.test.ts)에 절대 겹치지 않는다.
//
// fileParallelism: false — 워크로드 녹화가 실제 node-pty PTY를 스폰하므로(macOS forkpty),
// 파일 병렬 실행은 PTY 자원 경합을 부른다(rig 레인과 동일 정책). 차등 러너 자체는 @xterm/headless
// 인메모리라 빠르지만, 녹화 테스트와 같은 레인이라 보수적으로 직렬화한다.
export default defineConfig({
  // A CRLF hashbang line loads (scripts/lib/vitest-hashbang-lf.mjs).
  plugins: [hashbangLf()],
  test: {
    include: ['core/harness/**/*.harness.test.ts'],
    environment: 'node',
    fileParallelism: false,
    // PTY 스폰 + 대량 feed가 있어 기본 5초는 빠듯할 수 있다. 넉넉히 잡는다.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
