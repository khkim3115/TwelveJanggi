// 트레이 앱 빌드 도구 — 웹 설정(vite.config.ts)과 트레이 설정(vite.tray.config.ts)이 함께 쓴다(설계 §5.3 · §5.4).
// - CSP 는 한 원본이다: buildTrayCsp 가 만든 문자열을 tray.html 의 meta 와 tray-build.json(→ 앱 처리기의 응답
//   헤더)에 그대로 쓴다. 스모크가 두 전달 경로의 originalPolicy 를 이 문자열과 대조한다.
// - 빌드 분리 가드는 양방향이다: 트레이 빌드에 웹 전용 모듈(앱 셸 · PWA)이, 웹 빌드에 트레이 모듈이 들어오면
//   빌드가 스스로 실패한다. 판정은 문자열만 보는 순수 함수라 Windows 모양의 경로도 ubuntu CI 에서 같은 답을 낸다.
// 최상위 부작용이 없다 — 두 Vite 설정 말고도 desktop/lib 의 vitest 시험(mainWiring · smokeChecks · smokeRun · trayBuildInfo)이
// buildTrayCsp · buildTrayBuildInfo 를 쓰려고 import 한다(Vite 는 타입만 가져온다).

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Plugin, Rollup } from 'vite';

const TRAY_HTML = 'tray.html';
const TRAY_BUILD_JSON = 'tray-build.json';
const CHARSET_META = '<meta charset="UTF-8" />';
/** 트레이 출력의 AI 모듈 워커(Vite 워커 하위 빌드의 진입 청크). */
const AI_WORKER_RE = /^assets\/ai\.worker-[\w-]+\.js$/;
/** vite-plugin-pwa 가상 모듈 id 두 형태 — '\0virtual:pwa-*' 와 '/@vite-plugin-pwa/virtual:pwa-register*'. */
const PWA_VIRTUAL_RE = /^(?:virtual:pwa-|\/@vite-plugin-pwa\/)/i;
/** 트레이 출력에 있으면 안 되는 웹(PWA) 산출물. 이름이 workbox- 로 시작하는 파일도 같다. */
const WEB_OUTPUT_FILES = new Set(['index.html', 'sw.js', 'registerSW.js', 'manifest.webmanifest']);

/** import.meta.url 이 가리키는 파일의 폴더(끝 구분자 포함). 두 Vite 설정과 시험이 가드 루트로 쓴다. */
export function repoRoot(importMetaUrl: string): string {
  return fileURLToPath(new URL('.', importMetaUrl));
}

// ── CSP ─────────────────────────────────────────────────────────────────

export interface TrayCsp {
  /** 문서 meta 판. */
  meta: string;
  /** 응답 헤더 판 = meta + frame-ancestors(meta 안의 frame-ancestors 는 무시되고 경고가 난다). */
  header: string;
  /** connect-src 에 넣은 Supabase https(또는 로컬 http) 출처. 값이 없으면 null. */
  supabaseOrigin: string | null;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);
const HOSTNAME_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

/**
 * VITE_SUPABASE_URL → connect-src 에 넣을 두 출처. 정책 문자열에 그대로 들어가므로 좁게 받는다.
 * - https 만 받는다. http(→ ws)는 브라우저 확인용 가짜 값을 위해 localhost · 127.0.0.1 만
 * - 사용자 정보는 받지 않고, 호스트는 [a-z0-9.-] 만 받는다 — Node URL 은 호스트의 ; , ' 를 받아 지시문을 끼우거나(;)
 *   헤더를 두 정책으로 가를(,) 수 있다
 * - 출처는 프로토콜 + URL.host(기본이 아닌 포트는 남는다)로 새로 만든다. 경로 · 쿼리는 버린다
 * 값 자체는 오류 문구에 넣지 않는다 — 사용자 정보가 든 값이 빌드 로그에 남지 않게.
 */
function supabaseOrigins(value: string): { http: string; ws: string } {
  const fail = (why: string): never => {
    throw new Error(`VITE_SUPABASE_URL 이 잘못됐다 — ${why}`);
  };
  if (/[^\x21-\x7e]/.test(value)) fail('공백 · 제어 문자 · ASCII 밖 글자가 있다');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('URL 이 아니다');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(`https 여야 한다(${url.protocol})`);
  if (url.username || url.password) fail('사용자 정보를 넣을 수 없다');
  if (!HOSTNAME_RE.test(url.hostname)) fail('호스트는 영문 소문자 · 숫자 · 점 · 하이픈만 쓸 수 있다');
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) fail('http 는 localhost · 127.0.0.1 만 받는다');
  const ws = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return { http: `${url.protocol}//${url.host}`, ws: `${ws}//${url.host}` };
}

/**
 * 트레이 CSP. 지시문 순서 · 구분자는 고정이다(설계 §5.3 — 스모크가 문자열로 대조한다).
 * Supabase 값이 있으면 connect-src 에 https · wss 출처를 둘 다 적는다(CSP3 에서 https 는 wss 를 덮지 않는다).
 * 값이 잘못됐으면 throw 한다 — configResolved 에서 불러 번들링 전에 멈춘다.
 */
export function buildTrayCsp(supabaseUrl: string | undefined): TrayCsp {
  const origins = supabaseUrl ? supabaseOrigins(supabaseUrl) : null;
  const connect = origins ? `'self' ${origins.http} ${origins.ws}` : "'self'";
  const meta = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "worker-src 'self'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
  return { meta, header: `${meta}; frame-ancestors 'none'`, supabaseOrigin: origins ? origins.http : null };
}

/** tray-build.json — 앱 main 이 검증해서 응답 헤더 · 스모크 기대값으로 쓴다(없거나 틀리면 fail-closed). */
export interface TrayBuildInfo {
  csp: { meta: string; header: string };
  supabaseOrigin: string | null;
  /**
   * AI 워커 스크립트의 출력 경로(assets/ai.worker-*.js). 워커 청크가 없는 빌드는 null — tray-build.json 검증(parseTrayBuild)은
   * 받지만 스모크의 cspHeader 가 실패시킨다(워커 응답 헤더를 볼 수 없다). 트레이 진입이 스모크 훅(src/tray/smoke.ts → aiClient)으로
   * AI 워커를 들이므로 build:tray 는 경로를 적는다.
   */
  workerScript: string | null;
  builtAt: string;
  commit: string | null;
}

export function buildTrayBuildInfo(
  csp: TrayCsp,
  workerScript: string | null,
  builtAt: string,
  commit: string | null,
): TrayBuildInfo {
  return { csp: { meta: csp.meta, header: csp.header }, supabaseOrigin: csp.supabaseOrigin, workerScript, builtAt, commit };
}

/** CSP meta 태그. 정책은 escape 없이 속성 값에 들어간다 — 그래서 넣기 전에 글자를 본다. */
function cspMetaTag(meta: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${meta}" />`;
}

/**
 * `<meta charset="UTF-8" />` 바로 뒤에 CSP meta 를 넣는다. 문자열 치환이라 속성 escape 를 피하고, Vite 가 넣는
 * script · link 보다 앞에 온다. charset 이 없으면 멈춘다.
 */
export function injectCspMeta(html: string, meta: string): string {
  if (/["&<>\r\n\0]/.test(meta)) throw new Error('CSP 정책에 속성 값을 깨는 글자가 있다');
  const at = html.indexOf(CHARSET_META);
  if (at === -1) throw new Error(`트레이 HTML 에 ${CHARSET_META} 가 없다 — CSP meta 를 그 바로 뒤에 넣는다`);
  const end = at + CHARSET_META.length;
  const lineStart = html.lastIndexOf('\n', at) + 1;
  const indent = /^[ \t]*$/.test(html.slice(lineStart, at)) ? html.slice(lineStart, at) : '';
  return `${html.slice(0, end)}\n${indent}${cspMetaTag(meta)}${html.slice(end)}`;
}

function cspMetaFollowsCharset(html: string, meta: string): boolean {
  const at = html.indexOf(CHARSET_META);
  return at !== -1 && html.slice(at + CHARSET_META.length).trimStart().startsWith(cspMetaTag(meta));
}

// ── 빌드 분리 가드 ───────────────────────────────────────────────────────

/** 트레이 빌드에 들어오면 안 되는 모듈(설계 §5.4) — 앱 셸 · PWA 의존. PWA 가상 모듈은 따로 본다. */
export const WEB_ONLY_MODULES: readonly string[] = Object.freeze([
  'src/main.tsx',
  'src/ui/PwaStatus.tsx',
  'src/ui/InstallButton.tsx',
  'src/ui/DownloadCards.tsx',
  'src/ui/Header.tsx',
  'src/ui/Home.tsx',
  'src/store/appStore.ts',
]);
const WEB_ONLY_LOWER = new Set(WEB_ONLY_MODULES.map((file) => file.toLowerCase()));

/** '\0' 접두와 쿼리(?worker · ?url · ?import …)를 뗀 id. '#…' 접미는 toRepoPath 가 저장소 상대 부분에서 뗀다(루트의 '#' 은 그대로). */
function cleanId(id: string): string {
  const bare = id.startsWith('\0') ? id.slice(1) : id;
  const query = bare.indexOf('?');
  return query === -1 ? bare : bare.slice(0, query);
}

/**
 * 모듈 id → 저장소 상대 POSIX 경로. 루트 밖이면 null. 문자열만 본다(파일 시스템에 묻지 않는다).
 * '\' 를 '/' 로 바꾸고 루트 끝 '/' 를 뗀 뒤 접두를 대소문자 없이 비교한다 — win32 는 대소문자를 가리지 않고,
 * 같은 판정을 ubuntu CI 에서도 내야 한다. 접두 다음 글자가 '/' 여야 한다('/r2' 는 '/r' 안이 아니다).
 * 저장소 상대 부분의 '#…' 도 뗀다 — Vite 는 node_modules 밖의 'x.ts#y' 를 '?…' 처럼 x.ts 로 풀고 '#y' 를 id 에 남긴다.
 * (node_modules 안에서는 '#' 이 파일 이름일 수 있지만 웹 전용 목록 · 트레이 경로는 모두 node_modules 밖이다.)
 */
export function toRepoPath(id: string, root: string): string | null {
  const file = cleanId(id).replace(/\\/g, '/');
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (file.length <= base.length + 1 || file[base.length] !== '/') return null;
  if (file.slice(0, base.length).toLowerCase() !== base.toLowerCase()) return null;
  const path = file.slice(base.length + 1).replace(/#.*$/, '');
  return path === '' ? null : path;
}

export function isWebOnlyModule(id: string, root: string): boolean {
  if (PWA_VIRTUAL_RE.test(cleanId(id))) return true;
  const path = toRepoPath(id, root);
  return path !== null && WEB_ONLY_LOWER.has(path.toLowerCase());
}

/** tray.html · src/tray/** — 'tray' 부분 문자열이 아니라 경로로 본다(손패 HandTray 는 트레이 모듈이 아니다). */
export function isTrayModule(id: string, root: string): boolean {
  const path = toRepoPath(id, root)?.toLowerCase();
  return path !== undefined && (path === TRAY_HTML || path.startsWith('src/tray/'));
}

/** 오류 문구에 보일 id — 저장소 안이면 상대 경로, 밖(가상 모듈 등)이면 '\0' · 쿼리를 뗀 id. */
function shownId(id: string, root: string): string {
  return toRepoPath(id, root) ?? cleanId(id);
}

// 두 가드는 load 훅에서 본다 — load 는 리졸브가 끝난 최종 id(쿼리 포함)를 받아, import 를 어떻게 적었든(별칭 · 상대 경로 ·
// ?worker · ?url) 실제 파일로 판정한다('pre' 의 resolveId 도 불리지만 아직 풀지 않은 지정자를 받는다). enforce 'pre' 로 Vite 핵심
// 로더보다 먼저 돈다 — vite:worker 는 ?worker 를(빌드에서 ''), asset 은 ?url · ?raw 를 먼저 답해 load 'first' 사슬을
// 끝내므로, 'pre' 가 아니면 그런 import 는 가드에 오지 않는다. 검사 뒤에는 null 을 돌려 로딩을 Vite 에 맡긴다.
// 가져온 파일은 Rollup 이 오류 앞에 '(imported by …)' 로 적어 준다.

/** 트레이 빌드 가드. 트레이 설정의 plugins 와 worker.plugins(함수형) 둘 다에 넣는다 — plugins 는 워커 하위 빌드를 못 본다. */
export function trayGuard(root: string): Plugin {
  return {
    name: 'tj-tray-guard',
    enforce: 'pre',
    load(id) {
      if (isWebOnlyModule(id, root)) {
        this.error(`트레이 빌드에 웹 전용 모듈이 들어왔다: ${shownId(id, root)} — 쓸 부분은 순수 모듈로 옮긴다`);
      }
      return null;
    },
  };
}

/** 웹 빌드 가드(빌드에서만 — dev 에서 켜면 `npm run dev` → /tray.html 개발 흐름이 깨진다). plugins 와 worker.plugins 에 넣는다. */
export function webGuard(root: string): Plugin {
  return {
    name: 'tj-web-guard',
    apply: 'build',
    enforce: 'pre',
    load(id) {
      if (isTrayModule(id, root)) this.error(`웹 빌드에 트레이 모듈이 들어왔다: ${shownId(id, root)}`);
      return null;
    },
    writeBundle(_options, bundle) {
      if (Object.keys(bundle).some((fileName) => fileName.toLowerCase() === TRAY_HTML)) {
        this.error(`웹 빌드 출력에 ${TRAY_HTML} 이 있다 — 트레이는 트레이 설정으로 따로 빌드한다`);
      }
    },
  };
}

// ── 트레이 CSP · 빌드 정보 · 출력 검사 ───────────────────────────────────

/** 지금 커밋(짧은 해시). git 이 없거나 저장소가 아니면 null. */
function gitCommit(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    return /^[0-9a-f]{4,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * 트레이 출력 검사(설계 §5.4) — 쓰기가 성공한 뒤 메모리의 bundle 을 본다. 문제마다 한 줄을 돌려준다.
 * 없어야 할 것: 웹(PWA) 산출물, tray.html 의 manifest 링크 · 절대 /TwelveJanggi/. 있어야 할 것: charset 바로 뒤 CSP meta.
 */
function trayOutputProblems(bundle: Rollup.OutputBundle, meta: string): string[] {
  const problems: string[] = [];
  for (const fileName of Object.keys(bundle)) {
    const name = fileName.slice(fileName.lastIndexOf('/') + 1);
    if (WEB_OUTPUT_FILES.has(name) || name.startsWith('workbox-')) problems.push(`웹(PWA) 산출물 ${fileName} 이 있다`);
  }
  const entry = bundle[TRAY_HTML];
  if (entry?.type !== 'asset') return [...problems, `${TRAY_HTML} 이 없다`];
  const html = typeof entry.source === 'string' ? entry.source : new TextDecoder().decode(entry.source);
  if (!cspMetaFollowsCharset(html, meta)) problems.push(`${TRAY_HTML} 의 ${CHARSET_META} 바로 뒤에 CSP meta 가 없다`);
  if (/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\bmanifest\b/i.test(html)) problems.push(`${TRAY_HTML} 에 manifest 링크가 있다`);
  if (html.includes('/TwelveJanggi/')) problems.push(`${TRAY_HTML} 에 절대 경로 /TwelveJanggi/ 가 있다`);
  return problems;
}

/**
 * 트레이 CSP 플러그인(빌드에서만 — dev 에는 CSP 가 없다). 트레이 설정의 plugins 에만 넣는다(워커 하위 빌드마다 돌면 안 된다).
 * - configResolved: config.env.VITE_SUPABASE_URL 로 정책을 만든다 — 번들의 import.meta.env 와 같은 값이다
 * - transformIndexHtml: charset 바로 뒤에 meta
 * - generateBundle: tray-build.json(AI 워커 청크는 vite:worker 가 먼저 bundle 에 넣는다)
 * - writeBundle: 출력 검사. closeBundle 은 실패한 빌드에서도 돌아 원래 오류를 가리므로 쓰지 않는다
 */
export function trayCsp(): Plugin {
  let csp: TrayCsp | null = null;
  let root = '';
  const policy = (): TrayCsp => {
    if (!csp) throw new Error('tj-tray-csp: configResolved 전에 불렸다');
    return csp;
  };
  return {
    name: 'tj-tray-csp',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      csp = buildTrayCsp(config.env.VITE_SUPABASE_URL as string | undefined);
    },
    transformIndexHtml(html) {
      return injectCspMeta(html, policy().meta);
    },
    generateBundle(_options, bundle) {
      const workers = Object.keys(bundle).filter((fileName) => AI_WORKER_RE.test(fileName));
      if (workers.length > 1) this.error(`AI 워커 스크립트가 여럿이다: ${workers.join(', ')}`);
      const info = buildTrayBuildInfo(policy(), workers[0] ?? null, new Date().toISOString(), gitCommit(root));
      this.emitFile({ type: 'asset', fileName: TRAY_BUILD_JSON, source: `${JSON.stringify(info, null, 2)}\n` });
    },
    writeBundle(_options, bundle) {
      const problems = trayOutputProblems(bundle, policy().meta);
      if (problems.length > 0) this.error(`트레이 출력 검사 실패\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
    },
  };
}
