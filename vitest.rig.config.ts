import { defineConfig } from 'vitest/config';
import { hashbangLf } from './scripts/lib/vitest-hashbang-lf.mjs';

// 검증 리그 레인 (설계 §1 / G3). 기존 vitest 두 레인(test:parallel·test:runtime)과
// 완전히 분리된 세 번째 레인. include 글롭이 최상위 `rig/`의 `*.rig.test.ts`만 잡으므로
// 기존 레인(src/**/__tests__/**)에 절대 안 걸린다.
//
// fileParallelism: false — 각 시나리오가 실제 데몬 프로세스 + 격리 홈을 스폰하므로
// 파일 병렬 실행은 자원 경합·포트 충돌을 부른다(runtime 레인과 동일 정책).
export default defineConfig({
  // A CRLF hashbang line loads (scripts/lib/vitest-hashbang-lf.mjs).
  plugins: [hashbangLf()],
  test: {
    include: ['rig/**/*.rig.test.ts'],
    environment: 'node',
    fileParallelism: false,
    // 데몬 스폰 + ready 폴링이 있어 기본 5초 타임아웃은 빠듯하다. 개별 훅/테스트는
    // 자체 타임아웃도 명시하지만, 레인 기본을 넉넉히 잡아둔다.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
