// scripts/trayBuild.ts 시험 — CSP 한 원본(설계 §5.3) · tray-build.json · 웹 전용/트레이 import 가드(§5.4).
// 빌드 시험은 실제 Vite 빌드다. envDir 은 빈 임시 폴더라 .env* 를 읽지 않는다. Vite 는 process.env 의 VITE_* 도
// 읽으므로, Supabase 값이 결과에 닿는 시험은 vi.stubEnv 로 값을 정해 둔다(셸에 값이 있어도 결과가 같게).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  build,
  loadConfigFromFile,
  normalizePath,
  type Plugin,
  type PluginOption,
  type Rollup,
  type UserConfig,
} from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  WEB_ONLY_MODULES,
  buildTrayBuildInfo,
  buildTrayCsp,
  injectCspMeta,
  isTrayModule,
  isWebOnlyModule,
  repoRoot,
  toRepoPath,
  trayCsp,
  trayGuard,
  webGuard,
} from './trayBuild';

const ROOT = repoRoot(new URL('..', import.meta.url).href);
const BUILD_TIMEOUT = 60_000;

// Global Constraints 의 meta 판(Supabase 값 없음) 그대로다.
const META_NO_SUPABASE =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "worker-src 'self'; manifest-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const FRAME_ANCESTORS = "; frame-ancestors 'none'";
const CHARSET = '<meta charset="UTF-8" />';
const cspTag = (meta: string) => `<meta http-equiv="Content-Security-Policy" content="${meta}" />`;
// 트레이 HTML 모양(charset 이 head 의 첫 자식) — injectCspMeta 와 trayCsp 빌드 시험이 함께 쓴다.
const TRAY_HTML = [
  '<!doctype html>',
  '<html lang="ko">',
  '  <head>',
  `    ${CHARSET}`,
  '    <title>t</title>',
  '  </head>',
  '  <body>',
  '    <script type="module" src="./main.ts"></script>',
  '  </body>',
  '</html>',
  '',
].join('\n');

// 시험 임시 폴더 — mkdtemp 로 만들고 끝나면 지운다.
const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
let envDir = '';
beforeAll(() => {
  envDir = tempDir('tj-traybuild-env-');
});
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * 저장소 루트에서 fixture 하나를 진입으로 메모리 빌드한다(디스크에 쓰지 않는다).
 * 가드 음성 빌드는 이것을 쓴다 — 웹 가드 음성 빌드도 fixture 와 plugins 만 바꿔 부른다.
 */
function buildFixture(fixture: string, plugins: Plugin[]) {
  const input = fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url));
  return build({
    root: ROOT,
    configFile: false,
    envDir,
    logLevel: 'silent',
    build: { write: false, rollupOptions: { input } },
    plugins,
  });
}

/** 빌드가 실패해야 한다 — 그 오류를 돌려준다(통과하면 시험이 실패한다). */
async function buildError(run: Promise<unknown>): Promise<Rollup.RollupError> {
  try {
    await run;
  } catch (error) {
    return error as Rollup.RollupError;
  }
  throw new Error('빌드가 통과했다 — 실패해야 한다');
}

/** charset meta 다음에 오는 첫 태그(사이 공백은 건너뛴다). */
function tagAfterCharset(html: string): string | undefined {
  const at = html.indexOf(CHARSET);
  if (at === -1) return undefined;
  return /^\s*(<[^>]*>)/.exec(html.slice(at + CHARSET.length))?.[1];
}

describe('buildTrayCsp', () => {
  it('Supabase 값이 없으면 connect-src 는 self 만, header 판은 frame-ancestors 를 더한다', () => {
    for (const value of [undefined, '']) {
      expect(buildTrayCsp(value)).toStrictEqual({
        meta: META_NO_SUPABASE,
        header: META_NO_SUPABASE + FRAME_ANCESTORS,
        supabaseOrigin: null,
      });
    }
  });

  it('https 값은 https · wss 출처를 둘 다 적고 경로는 버린다 — 다른 지시문은 그대로', () => {
    for (const value of ['https://abc.supabase.co', 'https://abc.supabase.co/rest/v1/']) {
      const csp = buildTrayCsp(value);
      const connect = "connect-src 'self' https://abc.supabase.co wss://abc.supabase.co;";
      expect(csp.meta).toContain(connect);
      expect(csp.meta).toBe(META_NO_SUPABASE.replace("connect-src 'self';", connect));
      expect(csp.header).toBe(csp.meta + FRAME_ANCESTORS);
      expect(csp.supabaseOrigin).toBe('https://abc.supabase.co');
    }
  });

  it('localhost · 127.0.0.1 은 http · ws 를 받고 포트를 지킨다', () => {
    const local = buildTrayCsp('http://127.0.0.1:9');
    expect(local.meta).toContain("connect-src 'self' http://127.0.0.1:9 ws://127.0.0.1:9;");
    expect(local.supabaseOrigin).toBe('http://127.0.0.1:9');
    expect(buildTrayCsp('http://localhost:54321').meta).toContain(
      "connect-src 'self' http://localhost:54321 ws://localhost:54321;",
    );
    expect(buildTrayCsp('https://abc.supabase.co:8443').meta).toContain(
      "connect-src 'self' https://abc.supabase.co:8443 wss://abc.supabase.co:8443;",
    );
  });

  it('https 가 아니거나 정책을 깨는 값은 빌드를 멈춘다', () => {
    const bad = [
      'http://example.com', // http 는 localhost · 127.0.0.1 만
      'nope',
      'ws://127.0.0.1:9',
      'wss://abc.supabase.co',
      'ftp://abc.supabase.co',
      // Node URL 은 호스트의 ; , ' 를 받는다 — ; 는 지시문을 끼우고 , 는 헤더를 두 정책으로 가른다
      'https://a.b;c',
      'https://a.b,c',
      "https://a.b'c",
      'https://abc.supabase.co;script-src',
      'https://user:pw@abc.supabase.co', // 사용자 정보
      'https://[::1]',
      'https://abc.supabase.co\n',
      'https://abc.supabase.co\r\nX: y',
      'https://abc.supa\nbase.co',
      'https://abc.supabase.co\0',
      ' https://abc.supabase.co',
      'https://abc.supabase.co\t',
    ];
    for (const value of bad) expect(() => buildTrayCsp(value), JSON.stringify(value)).toThrow(/VITE_SUPABASE_URL/);
  });

  it('결과에 CR · LF · NUL 이 없다', () => {
    for (const value of [undefined, '', 'https://abc.supabase.co/rest/v1/', 'http://127.0.0.1:9', 'http://localhost']) {
      const csp = buildTrayCsp(value);
      for (const text of [csp.meta, csp.header, csp.supabaseOrigin ?? '']) expect(text).not.toMatch(/[\r\n\0]/);
    }
  });
});

describe('injectCspMeta', () => {
  it('<meta charset="UTF-8" /> 바로 다음 요소로 넣는다', () => {
    const { meta } = buildTrayCsp(undefined);
    const out = injectCspMeta(TRAY_HTML, meta);
    expect(tagAfterCharset(out)).toBe(cspTag(meta));
    expect(out).toBe(TRAY_HTML.replace(CHARSET, `${CHARSET}\n    ${cspTag(meta)}`));
  });

  it('charset meta 가 없으면 멈춘다', () => {
    expect(() => injectCspMeta('<html><head><title>t</title></head></html>', 'x')).toThrow();
    expect(() => injectCspMeta('<html><head><meta charset="utf-8"></head></html>', 'x')).toThrow();
  });

  it('속성 값을 깨는 글자가 든 정책은 넣지 않는다(escape 하지 않으므로)', () => {
    for (const meta of ['a"b', 'a<b', 'a>b', 'a&b', 'a\nb']) expect(() => injectCspMeta(TRAY_HTML, meta)).toThrow();
  });
});

describe('repoRoot', () => {
  it('import.meta.url 의 폴더 — 한글 · 공백을 풀고 끝 구분자를 남기며, 그대로 가드 루트가 된다', () => {
    const dir = join(tmpdir(), '홍 길동', 'r');
    const root = repoRoot(pathToFileURL(join(dir, 'vite.tray.config.ts')).href);
    expect(root).toBe(dir + sep);
    // Vite 의 id 는 '/' 구분자의 실제 경로다
    expect(toRepoPath(`${dir.replace(/\\/g, '/')}/src/ui/Header.tsx`, root)).toBe('src/ui/Header.tsx');
  });
});

describe('toRepoPath', () => {
  it('실제 루트 형태 — Windows 구분자 · 끝 구분자 · 드라이브 대소문자 · 한글과 공백', () => {
    expect(toRepoPath('D:/r/src/ui/Header.tsx', 'D:\\r\\')).toBe('src/ui/Header.tsx');
    expect(toRepoPath('/r/src/x.ts', '/r/')).toBe('src/x.ts');
    expect(toRepoPath('d:/r/src/x.ts', 'D:\\r')).toBe('src/x.ts');
    expect(toRepoPath('D:/Google Drive/홍 길동/r/src/x.ts', 'D:\\Google Drive\\홍 길동\\r\\')).toBe('src/x.ts');
  });

  it("'\\0' · 쿼리 · '#' 접미를 뗀다 — 루트의 '#' 은 그대로", () => {
    expect(toRepoPath('\0/r/src/x.ts?worker&url', '/r/')).toBe('src/x.ts');
    expect(toRepoPath('D:\\r\\src\\x.ts?import', 'D:\\r\\')).toBe('src/x.ts');
    expect(toRepoPath('/r/src/x.ts#y', '/r/')).toBe('src/x.ts');
    expect(toRepoPath('D:\\r\\src\\x.ts#y?worker', 'D:\\r\\')).toBe('src/x.ts');
    expect(toRepoPath('/a#b/src/x.ts#y', '/a#b/')).toBe('src/x.ts');
  });

  it('루트 밖이면 null — 접두 함정 포함', () => {
    expect(toRepoPath('/r2/src/x.ts', '/r')).toBeNull();
    expect(toRepoPath('/other/src/x.ts', '/r/')).toBeNull();
    expect(toRepoPath('/r', '/r/')).toBeNull();
    expect(toRepoPath('/r/#y', '/r/')).toBeNull();
    expect(toRepoPath('virtual:pwa-register', '/r/')).toBeNull();
  });
});

const ROOTS = [
  { root: 'D:\\r\\', base: 'D:/r' },
  { root: '/r/', base: '/r' },
];

describe('isWebOnlyModule', () => {
  it('막을 모듈 목록 7개는 Windows · POSIX 루트 모두에서 웹 전용이다', () => {
    expect([...WEB_ONLY_MODULES].sort()).toEqual(
      [
        'src/main.tsx',
        'src/ui/PwaStatus.tsx',
        'src/ui/InstallButton.tsx',
        'src/ui/DownloadCards.tsx',
        'src/ui/Header.tsx',
        'src/ui/Home.tsx',
        'src/store/appStore.ts',
      ].sort(),
    );
    for (const { root, base } of ROOTS) {
      for (const file of WEB_ONLY_MODULES) expect(isWebOnlyModule(`${base}/${file}`, root), file).toBe(true);
    }
  });

  it('PWA 가상 모듈 · 쿼리나 # 접미가 붙은 id · 다른 대소문자도 웹 전용이다', () => {
    for (const id of [
      '\0virtual:pwa-register/react',
      'virtual:pwa-register',
      '\0virtual:pwa-info',
      '/@vite-plugin-pwa/virtual:pwa-register/react', // vite-plugin-pwa 가 푸는 id 형태
      '/r/src/ui/Header.tsx?worker',
      '/r/src/ui/Header.tsx?url',
      '/r/src/ui/Header.tsx?import',
      '/r/src/store/appStore.ts?raw',
      // node_modules 밖의 'x.ts#y' 는 Vite 가 x.ts 로 풀고 '#y' 를 id 에 남긴다('?…' 와 같다)
      '/r/src/store/appStore.ts#x',
      '/r/src/ui/Header.tsx?worker#x',
      '/r/src/ui/Header.tsx#x?worker',
    ]) {
      expect(isWebOnlyModule(id, '/r/'), id).toBe(true);
    }
    // win32 는 대소문자를 가리지 않는다 — 다르게 쓴 import 도 같은 파일로 풀린다
    expect(isWebOnlyModule('d:/R/SRC/ui/header.tsx?worker&url', 'D:\\r\\')).toBe(true);
  });

  it('트레이 진입 · 판 · 혼자 하기 스토어는 웹 전용이 아니다', () => {
    for (const { root, base } of ROOTS) {
      for (const file of ['src/tray/main.tsx', 'src/ui/Board.tsx', 'src/store/gameStore.ts']) {
        expect(isWebOnlyModule(`${base}/${file}`, root), file).toBe(false);
      }
    }
    expect(isWebOnlyModule('/other/src/ui/Header.tsx', '/r/')).toBe(false);
  });
});

describe('isTrayModule', () => {
  it('src/tray/** 와 tray.html 은 트레이 모듈이다', () => {
    for (const { root, base } of ROOTS) {
      for (const id of [
        `${base}/src/tray/TrayApp.tsx`,
        `${base}/tray.html`,
        `${base}/tray.html#x`,
        `${base}/src/tray/x.ts?worker&url`,
      ]) {
        expect(isTrayModule(id, root), id).toBe(true);
      }
    }
    expect(isTrayModule('d:/R/Src/Tray/TrayApp.tsx', 'D:\\r\\')).toBe(true);
  });

  it("손패(HandTray) · 공용 CSS 는 아니다 — 'tray' 부분 문자열 함정", () => {
    for (const { root, base } of ROOTS) {
      for (const id of [`${base}/src/ui/HandTray.tsx`, `${base}/src/index.css`, `${base}/src/trayx/a.ts`]) {
        expect(isTrayModule(id, root), id).toBe(false);
      }
    }
  });
});

describe('플러그인 모양', () => {
  it('이름 · 적용 범위 · 순서', () => {
    const tray = trayGuard(ROOT);
    const web = webGuard(ROOT);
    const csp = trayCsp();
    expect([tray.name, web.name, csp.name]).toEqual(['tj-tray-guard', 'tj-web-guard', 'tj-tray-csp']);
    expect(web.apply).toBe('build');
    expect(csp.apply).toBe('build');
    // 가드의 load 는 Vite 핵심 로더보다 먼저 돌아야 한다 — vite:worker 는 ?worker 를, asset 은 ?url · ?raw 를 먼저 답한다.
    expect(tray.enforce).toBe('pre');
    expect(web.enforce).toBe('pre');
  });
});

describe('trayGuard 음성 빌드', () => {
  it(
    'GameOver 는 appStore 를 들어 거부한다',
    async () => {
      const error = await buildError(buildFixture('guard-gameover.ts', [trayGuard(ROOT)]));
      expect(error.plugin).toBe('tj-tray-guard');
      expect(error.hook).toBe('load');
      expect(error.message).toContain('트레이 빌드에 웹 전용 모듈이 들어왔다: src/store/appStore.ts');
    },
    BUILD_TIMEOUT,
  );

  it(
    'Header 는 그 자체로 거부한다',
    async () => {
      // 설계는 InstallButton 을 예로 들었지만, Header 자체가 목록에 있어 먼저 걸린다.
      const error = await buildError(buildFixture('guard-header.ts', [trayGuard(ROOT)]));
      expect(error.plugin).toBe('tj-tray-guard');
      expect(error.hook).toBe('load');
      expect(error.message).toContain('트레이 빌드에 웹 전용 모듈이 들어왔다: src/ui/Header.tsx');
    },
    BUILD_TIMEOUT,
  );

  it(
    'Board 는 통과한다 — 같은 빌드 설정이 가드가 걸리지 않으면 성공한다',
    async () => {
      await expect(buildFixture('guard-board.ts', [trayGuard(ROOT)])).resolves.toBeDefined();
    },
    BUILD_TIMEOUT,
  );
});

describe('webGuard 음성 빌드', () => {
  it(
    'src/tray 를 들면 거부한다 — 같은 진입이 가드 없이는 빌드된다',
    async () => {
      // 대조: 가드가 없으면 통과해야 한다 — 거부가 가드 때문이지 진입이 깨져서가 아님을 보인다.
      await expect(buildFixture('guard-tray.ts', [])).resolves.toBeDefined();
      const error = await buildError(buildFixture('guard-tray.ts', [webGuard(ROOT)]));
      expect(error.plugin).toBe('tj-web-guard');
      expect(error.hook).toBe('load');
      expect(error.message).toContain('웹 빌드에 트레이 모듈이 들어왔다: src/tray/desktop.ts');
    },
    BUILD_TIMEOUT,
  );
});

// 가드가 워커 하위 빌드에서도 도는지 실제 빌드로 본다 — plugins 의 훅은 워커 하위 빌드를 보지 못해 worker.plugins 에 따로 넣는다.
// 임시 루트(진입 → 워커 → import)에서 가드를 worker.plugins 에만 두므로, 거부는 워커 하위 빌드에서만 나올 수 있다.
// 워커 하위 빌드의 오류는 Rollup 이 plugin 'vite:worker-import-meta-url' 로 다시 붙이므로 plugin 필드가 아니라 문구로 판정한다.
function workerGuardRoot(imported: string): string {
  // Vite 의 id 는 실제 경로다 — 가드 루트도 같은 형태여야 한다(macOS 의 /var → /private/var, Windows 8.3 이름 같은 별칭을 푼다).
  const dir = realpathSync.native(tempDir('tj-workerguard-'));
  for (const file of ['src/ui/Board.tsx', 'src/ui/Header.tsx', 'src/tray/x.ts']) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), 'export const x = 1;\n');
  }
  writeFileSync(join(dir, 'main.ts'), "new Worker(new URL('./w.ts', import.meta.url), { type: 'module' });\n");
  writeFileSync(join(dir, 'w.ts'), `import './${imported}';\n`);
  return dir;
}

function buildWithWorkerGuard(dir: string, guard: (root: string) => Plugin) {
  return build({
    root: dir,
    configFile: false,
    envDir,
    logLevel: 'silent',
    publicDir: false,
    build: { write: false, rollupOptions: { input: join(dir, 'main.ts') } },
    worker: { format: 'es', plugins: () => [guard(dir)] },
  });
}

describe('워커 하위 빌드의 가드', () => {
  it(
    'trayGuard — 워커가 웹 전용 모듈을 들면 거부한다',
    async () => {
      await expect(buildWithWorkerGuard(workerGuardRoot('src/ui/Board.tsx'), trayGuard)).resolves.toBeDefined();
      const error = await buildError(buildWithWorkerGuard(workerGuardRoot('src/ui/Header.tsx'), trayGuard));
      expect(error.message).toContain('[plugin tj-tray-guard]');
      expect(error.message).toContain('트레이 빌드에 웹 전용 모듈이 들어왔다: src/ui/Header.tsx');
    },
    BUILD_TIMEOUT,
  );

  it(
    'webGuard — 워커가 트레이 모듈을 들면 거부한다',
    async () => {
      await expect(buildWithWorkerGuard(workerGuardRoot('src/ui/Board.tsx'), webGuard)).resolves.toBeDefined();
      const error = await buildError(buildWithWorkerGuard(workerGuardRoot('src/tray/x.ts'), webGuard));
      expect(error.message).toContain('[plugin tj-web-guard]');
      expect(error.message).toContain('웹 빌드에 트레이 모듈이 들어왔다: src/tray/x.ts');
    },
    BUILD_TIMEOUT,
  );
});

// trayCsp 는 임시 루트(트레이 HTML · 진입 · AI 워커)로 디스크에 빌드한다 — writeBundle 은 쓰기 빌드에서만 돈다.
function trayCspRoot(trayHtml = TRAY_HTML): string {
  const dir = realpathSync.native(tempDir('tj-traycsp-'));
  writeFileSync(join(dir, 'tray.html'), trayHtml);
  writeFileSync(join(dir, 'main.ts'), "new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });\n");
  writeFileSync(join(dir, 'ai.worker.ts'), "self.postMessage('ok');\n");
  return dir;
}

function buildTray(dir: string, options: { base?: string; inputs?: string[]; plugins?: Plugin[] } = {}) {
  return build({
    root: dir,
    base: options.base ?? './',
    configFile: false,
    envDir,
    logLevel: 'silent',
    publicDir: false,
    build: {
      outDir: join(dir, 'out'),
      emptyOutDir: true,
      rollupOptions: { input: (options.inputs ?? ['tray.html']).map((file) => join(dir, file)) },
    },
    worker: { format: 'es' },
    plugins: [trayCsp(), ...(options.plugins ?? [])],
  });
}

describe('trayCsp 빌드', () => {
  it(
    'tray.html 의 charset 바로 뒤에 meta 를 넣고, tray-build.json 에 같은 정책과 AI 워커 경로를 적는다',
    async () => {
      vi.stubEnv('VITE_SUPABASE_URL', 'https://abc.supabase.co');
      const dir = trayCspRoot();
      await buildTray(dir);

      const csp = buildTrayCsp('https://abc.supabase.co');
      expect(tagAfterCharset(readFileSync(join(dir, 'out', 'tray.html'), 'utf8'))).toBe(cspTag(csp.meta));

      const { commit, ...info } = JSON.parse(readFileSync(join(dir, 'out', 'tray-build.json'), 'utf8'));
      expect(info).toStrictEqual({
        csp: { meta: csp.meta, header: csp.header },
        supabaseOrigin: 'https://abc.supabase.co',
        workerScript: expect.stringMatching(/^assets\/ai\.worker-[\w-]+\.js$/),
        builtAt: expect.any(String),
      });
      expect(existsSync(join(dir, 'out', info.workerScript))).toBe(true);
      expect(new Date(info.builtAt).toISOString()).toBe(info.builtAt);
      expect(commit === null || /^[0-9a-f]{4,40}$/.test(commit)).toBe(true);
    },
    BUILD_TIMEOUT,
  );

  it(
    'AI 워커가 없으면 workerScript 는 null 이다',
    async () => {
      vi.stubEnv('VITE_SUPABASE_URL', undefined);
      const dir = trayCspRoot();
      writeFileSync(join(dir, 'main.ts'), "document.title = 'x';\n");
      await buildTray(dir);
      const info = JSON.parse(readFileSync(join(dir, 'out', 'tray-build.json'), 'utf8'));
      expect(info.workerScript).toBeNull();
      expect(info.supabaseOrigin).toBeNull();
      expect(info.csp).toStrictEqual({ meta: META_NO_SUPABASE, header: META_NO_SUPABASE + FRAME_ANCESTORS });
    },
    BUILD_TIMEOUT,
  );

  it(
    '웹(PWA) 산출물 · manifest 링크 · 절대 /TwelveJanggi/ 가 있으면 쓰기 뒤에 빌드를 실패시킨다',
    async () => {
      vi.stubEnv('VITE_SUPABASE_URL', undefined);
      const dir = trayCspRoot(
        TRAY_HTML.replace('<title>', '<link rel="manifest" href="data:application/manifest+json,{}" />\n    <title>'),
      );
      writeFileSync(join(dir, 'index.html'), TRAY_HTML);
      const pwaLike: Plugin = {
        name: 'pwa-like',
        generateBundle() {
          for (const fileName of ['sw.js', 'registerSW.js', 'manifest.webmanifest', 'workbox-abc.js']) {
            this.emitFile({ type: 'asset', fileName, source: '' });
          }
        },
      };
      const error = await buildError(
        buildTray(dir, { base: '/TwelveJanggi/', inputs: ['tray.html', 'index.html'], plugins: [pwaLike] }),
      );
      expect(error.plugin).toBe('tj-tray-csp');
      expect(error.hook).toBe('writeBundle');
      const expected = ['index.html', 'sw.js', 'registerSW.js', 'manifest.webmanifest', 'workbox-abc.js'];
      for (const part of [...expected, 'manifest 링크', '/TwelveJanggi/']) expect(error.message).toContain(part);
    },
    BUILD_TIMEOUT,
  );

  it(
    'VITE_SUPABASE_URL 이 잘못됐으면 번들링 전에 멈춘다',
    async () => {
      vi.stubEnv('VITE_SUPABASE_URL', 'http://example.com');
      const dir = trayCspRoot();
      const error = await buildError(buildTray(dir));
      expect(error.message).toContain('VITE_SUPABASE_URL');
      expect(existsSync(join(dir, 'out'))).toBe(false);
    },
    BUILD_TIMEOUT,
  );
});

describe('buildTrayBuildInfo', () => {
  it('받은 값을 그대로 담는다', () => {
    const csp = buildTrayCsp('https://abc.supabase.co');
    expect(buildTrayBuildInfo(csp, 'assets/ai.worker-abc.js', '2026-10-27T00:00:00.000Z', 'abc1234')).toStrictEqual({
      csp: { meta: csp.meta, header: csp.header },
      supabaseOrigin: 'https://abc.supabase.co',
      workerScript: 'assets/ai.worker-abc.js',
      builtAt: '2026-10-27T00:00:00.000Z',
      commit: 'abc1234',
    });
    const empty = buildTrayCsp(undefined);
    expect(buildTrayBuildInfo(empty, null, 't', null)).toStrictEqual({
      csp: { meta: empty.meta, header: empty.header },
      supabaseOrigin: null,
      workerScript: null,
      builtAt: 't',
      commit: null,
    });
  });
});

// 배선 시험 — 설정 파일을 읽어(빌드 없이) 가드 · CSP 플러그인이 있어야 할 자리에 있는지, 그 자리의 가드가 일하는지 본다.
// 어떤 import 를 어떻게 막는지는 위의 빌드 시험이 본다 — 거기서는 시험이 가드를 직접 만든다. 여기서는 두 설정이 만든
// 가드 객체의 load 훅을 부른다. 가드의 루트는 설정 파일 안의 클로저라 이름만 봐서는 맞는지 알 수 없고, 루트가 틀린
// 가드(예: 엉뚱한 폴더 · 옮긴 설정 파일)는 이름이 같아도 아무것도 거부하지 않는다 — 시험은 초록인 채 빌드만 열린다.

/** 플러그인 옵션을 펼친다 — 중첩 배열(react() · VitePWA() 는 배열) · false · Promise 가 올 수 있다. */
async function flattenPlugins(option: PluginOption): Promise<Plugin[]> {
  const value = await option;
  if (!value) return [];
  if (Array.isArray(value)) return (await Promise.all(value.map(flattenPlugins))).flat();
  return [value];
}

async function pluginNames(option: PluginOption): Promise<string[]> {
  return (await flattenPlugins(option)).map((plugin) => plugin.name);
}

/** 설정 파일을 build 모드로 읽는다(저장소 루트 기준 상대 경로). 파일이 없거나 읽지 못하면 던진다. */
async function loadUserConfig(file: string) {
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, join(ROOT, file), ROOT);
  if (!loaded) throw new Error(`${file} 을 읽지 못했다`);
  return loaded.config;
}

/**
 * 플러그인의 load 훅을 저장소 안 파일(저장소 루트 기준 상대 경로)로 직접 불러 결과를 값으로 돌려준다. this.error 는
 * 던지는 가짜 문맥이라 거부하면 { rejected: 가드의 문구 }, 통과시키면 { passed: 훅의 반환값 }(가드는 null)이다.
 */
async function probeLoad(plugin: Plugin, file: string): Promise<{ rejected: string } | { passed: unknown }> {
  const hook = typeof plugin.load === 'function' ? plugin.load : plugin.load?.handler;
  if (!hook) throw new Error(`${plugin.name} 에 load 훅이 없다`);
  const context = {
    error(message: Rollup.RollupError | string): never {
      throw new Error(typeof message === 'string' ? message : message.message);
    },
  };
  try {
    // 모듈 id 는 Vite 가 쓰는 모양('/' 구분자의 실제 경로)으로 준다
    return { passed: await hook.call(context as Rollup.PluginContext, normalizePath(join(ROOT, file))) };
  } catch (error) {
    return { rejected: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 설정이 만든 가드를 직접 부른다. plugins 의 가드와 worker.plugins() 의 가드는 따로 만들어지는 객체라 둘 다 본다.
 * 금지 모듈은 가드 자신의 문구로 거부돼야 하고, 허용 모듈은 null 로 통과해야 한다(로딩은 Vite 에 맡긴다).
 */
async function expectGuardsEnforce(config: UserConfig, name: string, forbidden: string, message: string) {
  // 두 가드 모두 통과시키는 모듈 — 거부가 아무거나 막는 가드 때문이 아님을 보인다
  const allowed = 'src/core/board.ts';
  const places = { plugins: config.plugins ?? [], 'worker.plugins()': config.worker?.plugins?.() ?? [] };
  for (const [place, option] of Object.entries(places)) {
    // 가드가 없는 채로 통과하지 못하게 — 자리마다 정확히 하나여야 한다
    const guards = (await flattenPlugins(option)).filter((plugin) => plugin.name === name);
    expect(guards, `${place} 의 ${name} 개수`).toHaveLength(1);
    const [guard] = guards;
    expect(await probeLoad(guard, forbidden), `${place} 의 ${name} → ${forbidden}`).toEqual({
      rejected: expect.stringContaining(message),
    });
    expect(await probeLoad(guard, allowed), `${place} 의 ${name} → ${allowed}`).toEqual({ passed: null });
  }
}

describe('Vite 설정 배선', () => {
  it(
    '트레이 설정 — 가드 · CSP 는 plugins 에, 가드만 worker.plugins 에 있고 두 가드는 웹 전용 모듈을 거부한다',
    async () => {
      const config = await loadUserConfig('vite.tray.config.ts');
      const names = await pluginNames(config.plugins ?? []);
      expect(names).toEqual(expect.arrayContaining(['tj-tray-guard', 'tj-tray-csp']));
      // 트레이 출력에 PWA 도, 웹 가드도 없다
      expect(names.filter((name) => name.startsWith('vite-plugin-pwa') || name === 'tj-web-guard')).toEqual([]);
      // CSP · 출력 검사는 워커 번들마다 돌게 되므로 워커에는 가드만 넣는다
      expect(await pluginNames(config.worker?.plugins?.() ?? [])).toEqual(['tj-tray-guard']);
      // 가드 루트 = 빌드 루트(저장소 루트)이고 진입도 거기서 푼다(상대 경로는 cwd 기준이라 다른 폴더에서 못 찾는다).
      // publicDir false 는 public/ 의 웹 자원이 트레이 출력에 복사되는 것을 막는다.
      expect(config).toMatchObject({
        root: ROOT,
        base: './',
        publicDir: false,
        worker: { format: 'es' },
        build: { outDir: 'dist-tray', emptyOutDir: true, rollupOptions: { input: resolve(ROOT, 'tray.html') } },
      });
      // 설정이 만든 가드가 일한다 — 가드 루트가 틀리면 위의 이름 검사는 그대로 통과하고 가드만 꺼진다
      await expectGuardsEnforce(
        config,
        'tj-tray-guard',
        'src/ui/Header.tsx',
        '트레이 빌드에 웹 전용 모듈이 들어왔다: src/ui/Header.tsx',
      );
    },
    BUILD_TIMEOUT,
  );

  it(
    '웹 설정 — 웹 가드가 plugins 와 worker.plugins 에 있고 둘 다 트레이 모듈을 거부하며 트레이 플러그인은 없다',
    async () => {
      const config = await loadUserConfig('vite.config.ts');
      const names = await pluginNames(config.plugins ?? []);
      expect(names).toContain('tj-web-guard');
      expect(names.filter((name) => name.startsWith('tj-tray'))).toEqual([]);
      expect(await pluginNames(config.worker?.plugins?.() ?? [])).toEqual(['tj-web-guard']);
      // 나머지 옵션은 그대로다
      expect(config).toMatchObject({ base: './', worker: { format: 'es' } });
      // 설정이 만든 가드가 일한다 — 웹 Vite 루트는 cwd 라 트레이 설정처럼 root 옵션으로는 가드 루트를 볼 수 없다
      await expectGuardsEnforce(
        config,
        'tj-web-guard',
        'src/tray/desktop.ts',
        '웹 빌드에 트레이 모듈이 들어왔다: src/tray/desktop.ts',
      );
    },
    BUILD_TIMEOUT,
  );
});
