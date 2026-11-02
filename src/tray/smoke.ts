// 트레이 앱 페이지 쪽 스모크 훅(설계 §5.8) — tray.html?smoke 일 때만 window.__tjTraySmoke 를 둔다.
// 앱 안 실행기(설계 §5.10 의 desktop/smoke/run.cjs)가 페이지에서 이 객체의 메서드를 불러, 페이지 안에서만 보이는 사실을 모은다.
// - ai():           AI 가 모듈 워커에서 돌았는지(조용한 동기 폴백이 아닌지) · 합법 수를 냈는지. 경로를 본다 — 시간 예산은 보지 않는다.
// - net():          `--net` 일 때만 실행기가 부른다. 인증 설정 GET 과 Realtime 채널 join/leave 뿐이다. 익명 로그인 · 방 만들기 ·
//                   RPC · 쓰기는 하지 않는다(공유 Supabase 이고, 이 앱에는 아직 대전 화면이 없다). SmokeSupabase 에 그 면이 없는 것도 그래서다.
// - connectProbe(): 빌드의 Supabase 출처가 .invalid(CI 의 가짜 값)일 때만 그 https · wss 로 요청을 시도한다. 실제 요청은
//                   실행기의 noNetwork 가드가 취소하고, 여기서는 CSP 가 막지 않는다는 것만 본다.
// - bridge():       preload 가 노출한 window.tjDesktop 의 키와 계약 상수. 같은지는 실행기가 판정한다.
// 이 모듈은 불러오는 것만으로는 아무것도 하지 않는다 — 네트워크는 net() · connectProbe() 를 부를 때만 나간다.
// 대기 상한(실행기가 자기 감시 시간을 정할 때 본다): ai() 10초 · net() 의 join 10초(+ 정리는 라이브러리의 시간 제한까지) ·
// connectProbe() 는 요청(fetch · 소켓)마다 3초. 상한에 걸리면 던지지 않고 결과 필드로 보고한다.
// 의존(fetch · 소켓 · Supabase · AI)은 SmokeDeps 로 받는다. 단위 시험이 그 자리를 가짜로 갈아 끼워, 네트워크에 나가지 않고도
// 위 약속을 확인한다. Supabase 는 공용 로더(lib/loadSupabase)로만 받는다 — lib/supabase 를 따로 import 하지 않는다.

import { createInitialState, isLegal, type GameState } from '../core/gameState';
import type { Difficulty } from '../engine/ai';
import { cancelPendingAi, getAiPath, requestAiMove, type AiAnswer, type AiPath } from '../engine/aiClient';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../lib/env';
import { loadSupabase } from '../lib/loadSupabase';
import { TJ_DESKTOP_KEYS, desktop } from './desktop';

export interface SmokeAiResult {
  /** 요청이 어느 길로 끝났는지(aiClient.getAiPath). 'worker' 여야 통과다 — 판정은 실행기가 한다. */
  aiWorker: AiPath;
  /** AI 가 수를 냈는가(null 이 아님). */
  aiAnswered: boolean;
  /** 낸 수가 시작 국면의 합법 수인가. */
  legal: boolean;
  /** 요청부터 답까지(ms). 정보다 — 시간으로 판정하지 않는다. */
  ms: number;
}

export interface SmokeNetResult {
  /** 빌드에 Supabase 값이 있는가. false 면 다른 필드는 비어 있다. */
  configured: boolean;
  /** 인증 설정 GET 의 HTTP 상태. 요청이 나가지 못했으면 null. */
  settingsStatus: number | null;
  /** 소켓이 열려 있는가(join 응답을 기다린 뒤, 채널을 지우기 전에 본다). 채널 권한 오류여도 소켓이 붙으면 true 다. */
  realtimeConnected: boolean;
  /** 채널 join 응답(SUBSCRIBED · CHANNEL_ERROR · TIMED_OUT · CLOSED). 10초 안에 응답이 없으면 null. */
  joinStatus: string | null;
  /** 예외로 끝난 단계의 문구('단계: 메시지'를 '; ' 로 이었다). 없으면 null. */
  error: string | null;
}

export interface SmokeConnectResult {
  /** 시도한 URL(fetch 의 https, 소켓의 wss). .invalid 빌드가 아니면 빈 배열이다. */
  attempted: string[];
}

export interface TraySmokeApi {
  ai(): Promise<SmokeAiResult>;
  net(): Promise<SmokeNetResult>;
  connectProbe(): Promise<SmokeConnectResult>;
  /** Object.keys(window.tjDesktop ?? {}) 와 계약 상수 TJ_DESKTOP_KEYS. */
  bridge(): { keys: string[]; contract: string[] };
}

declare global {
  interface Window {
    __tjTraySmoke?: TraySmokeApi;
  }
}

/** net() 이 채널에서 쓰는 면. */
export interface SmokeChannel {
  subscribe(callback: (status: string) => void): unknown;
}

/**
 * net() 이 Supabase 클라이언트에서 쓰는 면 — 채널 join · 연결 상태 · 정리뿐이다. auth · rpc · from 은 일부러 없다:
 * 익명 로그인 · 세션 · RPC · REST 호출이 타입에서 막힌다(진짜 클라이언트는 이 면을 포함하므로 그대로 받아진다).
 */
export interface SmokeSupabase {
  channel(name: string): SmokeChannel;
  removeChannel(channel: SmokeChannel): Promise<unknown>;
  realtime: { isConnected(): boolean; disconnect(): Promise<unknown> };
}

export interface SmokeSocket {
  addEventListener(type: 'open' | 'error' | 'close', listener: () => void): void;
  close(): void;
}

/** 스모크가 바깥 세계에 닿는 자리 — 실제는 browserDeps(), 시험은 가짜. */
export interface SmokeDeps {
  /** 빌드의 VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY(src/lib/env.ts). */
  supabaseUrl: string | undefined;
  supabaseAnonKey: string | undefined;
  fetch(url: string, init?: { headers?: Record<string, string> }): Promise<{ status: number }>;
  openSocket(url: string): SmokeSocket;
  /** 공용 로더(lib/loadSupabase) — 스토어와 같은 약속이다. */
  loadSupabase(): Promise<{ supabase: SmokeSupabase }>;
  ai: {
    requestAiMove(state: GameState, difficulty: Difficulty): Promise<AiAnswer>;
    getAiPath(): AiPath;
    cancelPendingAi(): void;
  };
}

/** ai() 가 답을 기다리는 상한. 'easy' 의 시간 예산이 0.1초(PRESETS)라 이만큼 걸리면 막힌 것이다 — 요청을 버리고 미응답으로 보고한다. */
const AI_WAIT_MS = 10_000;
/** net() 이 채널 join 응답을 기다리는 상한(설계: 10초). */
const JOIN_WAIT_MS = 10_000;
/** connectProbe() 가 요청 하나(fetch · 소켓)를 기다리는 상한. */
const PROBE_WAIT_MS = 3_000;
/** connectProbe() 가 두는 경로 — 어느 서버에도 없다. */
const PROBE_PATH = '/tj-connect-probe';

const TIMED_OUT = Symbol('timed out');

/** work 를 ms 까지만 기다린다. 상한이 먼저면 TIMED_OUT, work 가 던지면 그대로 던진다. 어느 쪽이든 타이머는 남기지 않는다. */
function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function runAi(deps: SmokeDeps): Promise<SmokeAiResult> {
  const state = createInitialState();
  const started = performance.now();
  const answer = await within(deps.ai.requestAiMove(state, 'easy'), AI_WAIT_MS);
  // 답이 없는 요청은 버린다 — 늦게 온 응답이 뒤 검사에 섞이지 않고, 계산 중인 워커도 끊긴다.
  if (answer === TIMED_OUT) deps.ai.cancelPendingAi();
  const move = answer === TIMED_OUT ? null : answer.move;
  return {
    // 경로를 본다(시간 예산이 아니라) — 조용한 동기 폴백은 'fallback' 으로 남는다.
    aiWorker: deps.ai.getAiPath(),
    aiAnswered: move !== null,
    legal: move !== null && isLegal(state, move),
    ms: Math.round(performance.now() - started),
  };
}

async function runNet(deps: SmokeDeps): Promise<SmokeNetResult> {
  const result: SmokeNetResult = { configured: false, settingsStatus: null, realtimeConnected: false, joinStatus: null, error: null };
  const { supabaseUrl, supabaseAnonKey } = deps;
  if (!supabaseUrl || !supabaseAnonKey) return result;
  result.configured = true;
  const errors: string[] = [];

  // 인증 서버가 살아 있고 anon 키가 통하는지 — 설정을 읽을 뿐 로그인이 아니다. URL 끝의 슬래시는 떼고 붙인다.
  try {
    const response = await deps.fetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/settings`, { headers: { apikey: supabaseAnonKey } });
    result.settingsStatus = response.status;
  } catch (err) {
    errors.push(`settings: ${errorText(err)}`);
  }

  // Realtime 소켓이 붙는지 — 공개 broadcast 채널 하나에 붙었다 떨어진다. 채널 권한 오류여도 소켓이 붙었으면 연결이다.
  let supabase: SmokeSupabase | null = null;
  let channel: SmokeChannel | null = null;
  try {
    supabase = (await deps.loadSupabase()).supabase;
    const probe = supabase.channel(`tj:probe-${crypto.randomUUID().slice(0, 8)}`);
    channel = probe;
    const joined = await within(
      new Promise<string>((resolve) => {
        probe.subscribe(resolve);
      }),
      JOIN_WAIT_MS,
    );
    result.joinStatus = joined === TIMED_OUT ? null : joined;
    // 정리 전에 본다 — 아래의 disconnect() 가 소켓을 닫는다.
    result.realtimeConnected = supabase.realtime.isConnected();
  } catch (err) {
    errors.push(`realtime: ${errorText(err)}`);
  }

  // 정리 — 단계마다 따로 시도한다. 채널 제거가 실패해도 소켓은 끊는다.
  // 소켓을 닫는 것은 disconnect() 다 — realtime-js 2.118 은 마지막 채널을 지워도 바로 끊지 않고 미룬다(기본 50초 =
  // 하트비트 간격 25초 × 2, lib/supabase 는 realtime 설정을 주지 않는다). removeChannel 과 겹치는 호출이 아니니 지우지 않는다.
  if (supabase) {
    if (channel) {
      try {
        await supabase.removeChannel(channel);
      } catch (err) {
        errors.push(`removeChannel: ${errorText(err)}`);
      }
    }
    try {
      await supabase.realtime.disconnect();
    } catch (err) {
      errors.push(`disconnect: ${errorText(err)}`);
    }
  }

  result.error = errors.length > 0 ? errors.join('; ') : null;
  return result;
}

/** 빌드의 Supabase URL 이 .invalid 호스트(CI 의 가짜 값)일 때만 그 https · wss 출처를 돌려준다. 실제 값 · 값 없음 · 이상한 값은 null. */
function invalidOrigins(value: string | undefined): { http: string; ws: string } | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname.endsWith('.invalid')) return null;
  return { http: url.origin, ws: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}` };
}

async function probeSocket(deps: SmokeDeps, url: string): Promise<void> {
  let socket: SmokeSocket;
  try {
    socket = deps.openSocket(url);
  } catch {
    return; // 만들다 던져도 시도는 한 것이다
  }
  // 막히든 취소되든 곧 error · close 가 온다. 아무 일도 없으면 상한까지만 기다린다.
  const ended = new Promise<void>((resolve) => {
    for (const type of ['open', 'error', 'close'] as const) socket.addEventListener(type, () => resolve());
  });
  await within(ended, PROBE_WAIT_MS);
  try {
    socket.close();
  } catch {
    // 이미 닫혔다
  }
}

async function runConnectProbe(deps: SmokeDeps): Promise<SmokeConnectResult> {
  const attempted: string[] = [];
  const origins = invalidOrigins(deps.supabaseUrl);
  if (!origins) return { attempted };

  // 오류는 무시한다 — CSP 가 막든 가드가 취소하든 요청이 나갔다는 것이 요점이다.
  const httpUrl = `${origins.http}${PROBE_PATH}`;
  attempted.push(httpUrl);
  await within(
    (async () => {
      await deps.fetch(httpUrl);
    })().catch(() => undefined),
    PROBE_WAIT_MS,
  );

  const socketUrl = `${origins.ws}${PROBE_PATH}`;
  attempted.push(socketUrl);
  await probeSocket(deps, socketUrl);
  return { attempted };
}

function bridge(): { keys: string[]; contract: string[] } {
  return { keys: Object.keys(desktop() ?? {}), contract: [...TJ_DESKTOP_KEYS] };
}

/** 실제 환경의 의존. fetch 는 감싼다 — 객체의 메서드로 부르면 브라우저가 Illegal invocation 을 던진다. */
function browserDeps(): SmokeDeps {
  return {
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    fetch: (url, init) => fetch(url, init),
    openSocket: (url) => new WebSocket(url),
    loadSupabase,
    ai: { requestAiMove, getAiPath, cancelPendingAi },
  };
}

/** 스모크 api 를 만든다. 만드는 것만으로는 아무 일도 하지 않는다. */
export function createTraySmokeApi(deps: SmokeDeps = browserDeps()): TraySmokeApi {
  return {
    ai: () => runAi(deps),
    net: () => runNet(deps),
    connectProbe: () => runConnectProbe(deps),
    bridge,
  };
}

/** location.search 가 스모크 표시인가 — desktop/preload.js 의 판정(URLSearchParams.has('smoke'))과 같아야 한다. */
export function isSmokeLocation(search: string): boolean {
  return new URLSearchParams(search).has('smoke');
}

/** ?smoke 일 때만 win.__tjTraySmoke 를 설치한다(api 를 안 주면 실제 api). 설치했으면 true. 스모크가 아니면 아무것도 하지 않는다. */
export function installTraySmoke(win: { location: { search: string }; __tjTraySmoke?: TraySmokeApi }, api?: TraySmokeApi): boolean {
  if (!isSmokeLocation(win.location.search)) return false;
  win.__tjTraySmoke = api ?? createTraySmokeApi();
  return true;
}
