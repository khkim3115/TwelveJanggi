'use strict';
// 창 검사(#21 설계 §5.5 '새 필수 검사') — 실행기(run.cjs)가 screenshot 바로 뒤에 theme → opacity → escHide → visibility 차례로 부른다.
// 페이지의 브리지 send · 키 이벤트 · 단추 클릭과 main 의 길(트레이 클릭 · 메뉴 클릭 · win.close())로 창 상태를 바꾸고, 메모리(getState
// 스냅샷) · 페이지 · 창 · 설정 파일 · 실행기의 기록(main 이 넘긴 메뉴 · 창 보이기 · 숨기기와 이유 · 민 채널 · 수신 기록 · 트레이 클릭)으로
// 판정한다.
// - 순서 장벽은 페이지의 `await tjDesktop.getState()` 다 — 같은 프레임의 IPC 라 앞의 send 와 main 이 민 push 가 응답보다 먼저 처리된다
//   (설계 §5.3 의 추론 — theme ① 이 실제 앱에서 처음 증명한다). 저장 예약(300ms)을 기다리지 않는 판정은 메모리 값(스냅샷)으로 한다.
//   '바뀌지 않음'(escHide ① ② 의 숨지 않음)은 이 장벽을 양성 기록으로 삼는다.
// - 색 · 투명도의 기대값은 여기 적은 글자다(설계 §5.1 · §5.5 — lib 값으로 계산하지 않는다: 같은 값을 두 곳이 계산하면 틀려도 같다).
// - 기다림(settings.json · 창 기록 · 페이지의 tapp-hidden)의 시간 초과는 그 검사의 판정(ok false · detail)이다 — 던지지 않는다(R12). 창 ·
//   webContents 가 파괴됐으면 만지지 않고 판정으로 적은 뒤 그 검사를 멈춘다(R29 — 파괴된 창을 만지면 던져서 실행 전체가 stage 실패가 된다).
//   기다림의 predicate 도 파괴를 먼저 본다.
// - 각 검사는 끝에 — 실패 길에서도(finally) — 창을 main 의 길로 보인 채 돌려놓는다(R13 — 실행기의 endShown: 마지막 숨김 기록에서 경합 시간 +
//   여유가 지난 뒤 연다). 돌려놓지 못하면(누를 것이 없다 · 기다림의 시간 초과) 그 검사의 실패다(R12 — 뒤 검사는 보이는 창을 전제로 한다, 설계
//   §5.5). 판정은 '지금 보이는가' 만 본다 — 앞 검사가 남긴 창 기록('마지막 기록이 show')은 보지 않는다(그 규칙은 tray 에만 있다). visibility
//   는 끈 스로틀도 끝에 다시 켠다. 스모크에서 창을 고정하지 않는다(고정은 저장되고 tray 가 체크 false 를 요구한다).
// - '우연한 숨김' 규칙은 escHide · visibility 에만 둔다(R14): 시작 때 창이 보이는지 보고(visibility 는 보인 기록이 이미 있는지도), 검사
//   도중 이 검사가 일으키지 않은 숨김 기록이 오면 그 이유를 상세에 적고 실패한다. theme · opacity 에는 두지 않는다(보임과 상관없는 검사라
//   흔들림만 늘린다).
// - 경합 창(CLICK_RACE_MS)을 재는 곳은 tray 의 열기와 escHide ④ 뿐이다. visibility 의 다시 보이기는 그 숨김 기록에서 경합 시간 + 여유가 지난
//   뒤 한다(R13 — main 의 경합 가드 결함이 이 검사로 번지지 않게).
// - 숨긴 동안 capturePage 를 하지 않는다(캡처하면 페이지가 visible 로 바뀐다 — 설계 §5.5).
// - 실행기의 사실 · 도우미(createSmokeRun 의 클로저)는 ctx 로 받는다 — 능동 검사의 ActiveContext 와 같은 모양이고 베끼지 않는다. 공용
//   도우미(support.cjs — until · untilAsync · waitElapsed …)와 페이지 코드(pageScripts.cjs)는 active.cjs 처럼 직접 가져온다. run.cjs 는
//   require 하지 않는다(순환). electron 도 require 하지 않는다.

const { isRecord } = require('../lib/guards.cjs');
const { CLICK_RACE_MS } = require('../lib/windowPolicy.cjs');
const { HIDDEN_STATE_SCRIPT, HIDE_BUTTON_SCRIPT, escScript, opacityScript, themeScript } = require('./pageScripts.cjs');
const { PAGE_MS, WAIT_MS, errorText, show, until, untilAsync, verdictOf, waitElapsed } = require('./support.cjs');

/**
 * 테마별 창 배경색 — 설계 §5.1 의 THEME_BACKGROUND 를 글자 그대로 적는다(lib/theme.cjs 에서 가져오지 않는다). body 배경 · --bg ·
 * getBackgroundColor() 를 모두 rgbOfHex 로 바꿔 이 값과 견준다.
 */
const THEME_COLORS = Object.freeze({ dark: '#0d1117', light: '#f5f6f8' });
/** 트레이 메뉴의 테마 항목(설계 §5.1 표의 글자). */
const LIGHT_LABEL = '라이트 모드';
/** main 이 테마를 렌더러에 미는 채널(설계 §5.3). */
const THEME_CHANNEL = 'tj-theme';
/** main 이 창을 숨기고 · 보인 뒤 렌더러에 미는 채널(설계 §5.3). */
const HIDDEN_CHANNEL = 'tj-hidden';
const SHOWN_CHANNEL = 'tj-shown';
/**
 * 투명도 표 — 설계 §5.5 표를 이 차례로 글자 그대로 적는다(lib 값으로 계산하지 않는다). send 는 페이지가 보내는 값(고치지 않는다), expect 는
 * main 이 남길 값(스냅샷 · 창), saves 는 저장값이 바뀌는 줄이다 — 그 줄만 settings.json 이 expect 가 될 때까지 기다린다(새 프로필의 100 에서
 * 시작한다). 잘못된 값('70' · NaN · null)은 기본값(100)도 경계값(30 · 100)도 아닌 64 에서 보낸다 — '기본값으로 바꿈' 과 '무시' 가 갈린다.
 * @type {readonly OpacityRow[]}
 */
const OPACITY_TABLE = Object.freeze([
  { send: 64, expect: 64, saves: true },
  { send: 5, expect: 30, saves: true },
  { send: 64.4, expect: 64, saves: true },
  { send: '70', expect: 64, saves: false },
  { send: Number.NaN, expect: 64, saves: false },
  { send: null, expect: 64, saves: false },
  { send: 150, expect: 100, saves: true },
  { send: 100, expect: 100, saves: false },
]);

/** @typedef {import('../lib/smokeChecks.cjs').CheckVerdict} CheckVerdict */
/** @typedef {import('./support.cjs').WindowFact} WindowFact */
/** @typedef {import('./run.cjs').FactMark} FactMark */
/** @typedef {'dark' | 'light'} Theme */
/**
 * 투명도 표 한 줄.
 * @typedef {{ send: unknown, expect: number, saves: boolean }} OpacityRow
 */
/**
 * 페이지가 본 <html> 의 tapp-hidden 과 document.visibilityState(HIDDEN_STATE_SCRIPT).
 * @typedef {{ hiddenClass: boolean, visibilityState: unknown }} HiddenState
 */
/**
 * tapp-hidden 기다림(waitHiddenClass)의 결과 — 기다린 것(want — 붙기 true · 빠지기 false)과 상한(ms), 되었는가(ok), 페이지가 답한 수
 * (answers) · 마지막에 본 것(last) · 마지막 답을 받은 때(lastAt — performance.now(), 답이 없으면 null).
 * @typedef {{ want: boolean, ms: number, ok: boolean, answers: number, last: HiddenState | null, lastAt: number | null }} ClassWait
 */
/**
 * 기다리지 않고 시작한 페이지 호출이 끝난 모양 — 값 또는 거부.
 * @typedef {{ kind: 'resolved', value: unknown } | { kind: 'rejected', error: unknown }} PageOutcome
 */
/**
 * main 의 길로 연 한 번(pressOpen) — 누르기 앞의 자리, 누르는 법(how) · 누를 것이 없을 때의 글(missing), 누를 것이 있었는가.
 * @typedef {{ from: FactMark, how: string, missing: string, pressed: boolean }} OpenPress
 */
/**
 * 창 검사가 실행기에서 받는 것 — 실행기(createSmokeRun)가 가진 사실과 도우미(클로저)를 그대로 넘긴다(능동 검사의 ActiveContext 와 같은
 * 모양).
 * @typedef {object} WindowContext
 * @property {import('./support.cjs').SmokeFacts} facts 수집한 사실 — window · sent · hideReceipts · opacityReceipts …
 * @property {string} platform main 이 넘긴 platform(process.platform 을 새로 읽지 않는다)
 * @property {() => import('electron').BrowserWindow} win 트레이 창
 * @property {readonly import('electron').Menu[]} menus main 이 setTray 로 넘긴 트레이 메뉴(넘긴 차례 — 맨 뒤가 최신이다. 실행기가 뒤에 쌓는다)
 * @property {readonly import('./run.cjs').TrayClick[]} trayClicks 실행기가 낸 트레이 좌클릭의 시각(낸 차례 — 실행기가 뒤에 쌓는다)
 * @property {(code: string, what: string, options?: import('./active.cjs').PageOptions) => Promise<unknown>} page main world 에서 돌린 값(상한이 있다)
 * @property {() => FactMark} mark 사실 목록의 길이 — 그 뒤에 온 것만 보려면 목록.slice(자리)다
 * @property {() => boolean} openViaMain main 의 길로 연다(win32 트레이 클릭 · 그 밖 최신 메뉴의 '열기'). 누를 것이 있었으면 true
 * @property {() => { how: string, missing: string }} openPath openViaMain 이 누르는 것과 누를 것이 없을 때의 글
 * @property {(records?: readonly WindowFact[]) => string[]} windowTrail 마지막 창 기록 몇 건(action:reason) — 실패 글에 싣는다
 * @property {(notes: string[]) => Promise<string | null>} endShown 창을 main 의 길로 보인 채 둔다(R13) — 다시 보였으면 notes 에 적는다. 끝에
 *   보이면 null, 아니면 그 이유(누를 것이 없다 · 기다림의 시간 초과 · 창 파괴)
 * @property {number} timingMarginMs 시각을 재는 기다림의 여유(ms — 기록의 at 은 main 이 시각을 잰 뒤에 붙어 조금 늦다)
 * @property {(hex: unknown) => string | null} rgbOfHex '#rrggbb' · '#rgb' → getComputedStyle 의 'rgb(r, g, b)', 그 모양이 아니면 null
 * @property {() => import('./run.cjs').SettingsRead} readSettings 프로필의 settings.json(정규화하지 않은 그대로)
 */
/**
 * 테마 한 단계 뒤에 본 것 — 페이지 사실(장벽 뒤), 창 배경(getBackgroundColor — 창이 파괴됐으면 null), 그 단계에 main 이 넘긴 메뉴와 민
 * tj-theme 수.
 * @typedef {object} ThemeView
 * @property {unknown} seen themeScript 의 답({ snapshot, dataTheme, bgToken, bodyBackground, stored })
 * @property {string | null} background
 * @property {import('electron').Menu[]} menus
 * @property {number} pushes
 */

/**
 * 투명도 표의 보낸 값을 글로 — NaN 은 'NaN'(값 표현은 JSON 이라 NaN 을 null 로 쓴다), 그 밖은 값 표현('70' 은 따옴표가 붙는다).
 * @param {unknown} value
 * @returns {string}
 */
function sentText(value) {
  return typeof value === 'number' && Number.isNaN(value) ? 'NaN' : show(value);
}

/**
 * 투명도 표 한 줄의 이름 — '보낸 값→기대값'.
 * @param {OpacityRow} row
 * @returns {string}
 */
function rowLabel(row) {
  return `${sentText(row.send)}→${row.expect}`;
}

/**
 * 메뉴의 '라이트 모드' 항목 — 메뉴가 없거나 그 항목이 없으면 undefined.
 * @param {import('electron').Menu | undefined} menu
 * @returns {import('electron').MenuItem | undefined}
 */
function lightItem(menu) {
  return menu?.items.find((item) => item.label === LIGHT_LABEL);
}

/**
 * 메뉴 항목의 지금 체크 — 부를 때마다 읽는다(Electron 은 click 전에 checkbox 의 checked 를 뒤집는다).
 * @param {import('electron').MenuItem} item
 * @returns {boolean}
 */
function checkedNow(item) {
  return item.checked;
}

/**
 * 문제마다 단계 표식을 붙인다.
 * @param {string} label
 * @param {readonly string[]} problems
 * @returns {string[]}
 */
function labelled(label, problems) {
  return problems.map((problem) => `${label} ${problem}`);
}

/**
 * tapp-hidden 기다림이 되지 않았을 때의 글 — 페이지가 한 번도 답하지 않았는가(읽지 못했다 — 숨긴 창의 렌더러가 늦거나 멈췄다)와, 답했지만
 * 붙지 · 빠지지 않았는가(렌더러가 클래스를 바꾸지 않았다)를 가른다. extra 는 괄호 안에 덧붙이는 사실(시각 · 설명)이다.
 * @param {ClassWait} wait
 * @param {readonly string[]} [extra]
 * @returns {string}
 */
function classMiss(wait, extra = []) {
  if (wait.answers === 0) {
    return `<html> 의 tapp-hidden 을 ${wait.ms}ms 동안 읽지 못했다 — 페이지가 한 번도 답하지 않았다${extra.length === 0 ? '' : `(${extra.join(' · ')})`}`;
  }
  const head = wait.want ? `<html> 에 tapp-hidden 이 ${wait.ms}ms 안에 붙지 않았다` : `<html> 의 tapp-hidden 이 ${wait.ms}ms 안에 빠지지 않았다`;
  return `${head} — 페이지는 ${wait.answers}번 답했다(${[`마지막에 본 것 ${show(wait.last)}`, ...extra].join(' · ')})`;
}

/**
 * 창 검사 한 벌을 만든다 — 검사마다 판정({ ok, detail })을 돌려주는 함수다. 실행기가 screenshot 바로 뒤에 theme → opacity → escHide →
 * visibility 차례로 부른다.
 * @param {WindowContext} ctx
 */
function createWindowChecks(ctx) {
  const { facts } = ctx;

  /**
   * 트레이 창이나 그 webContents 가 파괴됐으면 그 글, 아니면 null.
   * @returns {string | null}
   */
  function destroyed() {
    const win = ctx.win();
    if (win.isDestroyed()) return '트레이 창이 파괴됐다';
    return win.webContents.isDestroyed() ? '트레이 창의 webContents 가 파괴됐다' : null;
  }

  /**
   * 창이 파괴됐으면 그 문제를 적고 true(그 검사를 멈춘다 — 파괴된 창은 만지지 않는다, R29).
   * @param {string[]} problems
   * @param {string} label 멈춘 자리(단계 · 줄)
   * @param {string} [when] 그 자리의 언제(기본 '전에' — 단계 안이면 '도중에' · '… 뒤')
   * @returns {boolean}
   */
  function stopped(problems, label, when = '전에') {
    const gone = destroyed();
    if (gone === null) return false;
    problems.push(`${label} ${when} ${gone} — 검사를 멈춘다`);
    return true;
  }

  /**
   * 검사의 끝(finally) — 창을 main 의 길로 보인 채 돌려놓고(R13 — ctx.endShown), 그래도 보이지 않으면 그 이유로 그 검사의 실패를 적는다(R12).
   * '지금 보이는가' 만 본다(앞 검사가 남긴 창 기록은 보지 않는다).
   * @param {string[]} problems
   * @param {string[]} notes
   * @returns {Promise<void>}
   */
  async function restoreShown(problems, notes) {
    const why = await ctx.endShown(notes);
    if (why !== null) problems.push(`끝에 창을 main 의 길로 다시 보이지 못했다(${why})`);
  }

  /**
   * 색 값을 견줄 모양으로 — '#rrggbb' · '#rgb' 면 rgbOfHex 의 'rgb(r, g, b)', 아니면 본 그대로.
   * @param {unknown} value
   * @returns {unknown}
   */
  function colorOf(value) {
    return ctx.rgbOfHex(value) ?? value;
  }

  /**
   * settings.json(정규화하지 않은 그대로)의 key 가 expected 가 될 때까지 WAIT_MS 까지 기다린다(main 의 저장 예약 300ms). 되면 null, 시간이
   * 다 되면 그 문제(마지막에 본 값)다 — 던지지 않는다(R12).
   * @param {string} key
   * @param {unknown} expected
   * @returns {Promise<string | null>}
   */
  async function waitSaved(key, expected) {
    const saved = () => {
      const { raw, error } = ctx.readSettings();
      return error === null && isRecord(raw) && raw[key] === expected;
    };
    if (await until(saved, WAIT_MS)) return null;
    const { raw, error } = ctx.readSettings();
    if (error !== null) return `settings.json 을 ${WAIT_MS}ms 기다렸지만 읽지 못했다(${error}) — 기대 ${key} ${show(expected)}`;
    return `settings.json 의 ${key} 값을 ${WAIT_MS}ms 기다렸지만 ${show(isRecord(raw) ? raw[key] : raw)} 다(기대 ${show(expected)})`;
  }

  // ── theme ──────────────────────────────────────────────────────────

  /**
   * 테마 한 단계를 지켜본다 — act(페이지의 send + 장벽, 또는 메뉴 클릭 뒤 장벽)의 페이지 사실과 그 뒤의 창 배경, 그 사이 main 이 넘긴 메뉴 ·
   * 민 tj-theme 수를 모은다.
   * @param {() => Promise<unknown>} act
   * @returns {Promise<ThemeView>}
   */
  async function observeTheme(act) {
    const before = ctx.mark();
    const seen = await act();
    const win = ctx.win();
    return {
      seen,
      background: win.isDestroyed() ? null : win.getBackgroundColor(),
      menus: ctx.menus.slice(before.menus),
      pushes: facts.sent.slice(before.sent).filter((entry) => entry.channel === THEME_CHANNEL).length,
    };
  }

  /**
   * 한 단계 뒤의 테마 사실 — [주어(조사 포함), 값, 종류]. 메모리(스냅샷) · 페이지(data-theme · 저장값 · body 배경 · --bg) · 창
   * (getBackgroundColor). 색은 colorOf 로 바꾼 값이다.
   * @param {ThemeView} view
   * @returns {Array<[string, unknown, 'name' | 'color']>}
   */
  function themeFacts(view) {
    const seen = isRecord(view.seen) ? view.seen : {};
    return [
      ['스냅샷 theme 이', isRecord(seen.snapshot) ? seen.snapshot.theme : seen.snapshot, 'name'],
      ['data-theme 이', seen.dataTheme, 'name'],
      ['localStorage.tj_theme 이', seen.stored, 'name'],
      ['body 배경이', colorOf(seen.bodyBackground), 'color'],
      ['--bg 가', colorOf(seen.bgToken), 'color'],
      ['getBackgroundColor() 가', view.background === null ? '(창 파괴)' : colorOf(view.background), 'color'],
    ];
  }

  /**
   * 한 단계 뒤 모두가 theme 인가 — 이름은 theme 과, 색은 theme 의 글자 값(THEME_COLORS → rgbOfHex)과 견준다(body 배경 = --bg = 창 배경 =
   * 글자 값).
   * @param {ThemeView} view
   * @param {Theme} theme
   * @returns {string[]}
   */
  function themeStateProblems(view, theme) {
    if (!isRecord(view.seen)) return [`페이지 사실이 객체가 아니다: ${show(view.seen)}`];
    const color = ctx.rgbOfHex(THEME_COLORS[theme]);
    return themeFacts(view)
      .map(([subject, actual, kind]) => ({ subject, actual, want: kind === 'name' ? theme : color }))
      .filter(({ actual, want }) => actual !== want)
      .map(({ subject, actual, want }) => `${subject} ${show(actual)} 다(기대 ${show(want)})`);
  }

  /**
   * 받지 않는 값 뒤에 하나도 바뀌지 않았는가 — 테마 사실이 앞 단계(before) 뒤와 같다. 장벽이 양성 기록이다(앞의 send 가 처리된 뒤다).
   * @param {ThemeView} view
   * @param {ThemeView} before
   * @returns {string[]}
   */
  function unchangedProblems(view, before) {
    if (!isRecord(view.seen)) return [`페이지 사실이 객체가 아니다: ${show(view.seen)}`];
    const was = themeFacts(before);
    return themeFacts(view)
      .map(([subject, actual], at) => ({ subject, actual, previous: was[at]?.[1] }))
      .filter(({ actual, previous }) => actual !== previous)
      .map(({ subject, actual, previous }) => `${subject} ${show(previous)} 에서 ${show(actual)} 로 바뀌었다`);
  }

  /**
   * 그 단계에 main 이 넘긴 메뉴 · 민 tj-theme 수가 기대와 같고, 기대한 체크가 있으면 새 메뉴의 '라이트 모드' 가 그 체크다.
   * @param {ThemeView} view
   * @param {{ menus: number, pushes: number, checked?: boolean }} expected
   * @returns {string[]}
   */
  function deliveryProblems(view, expected) {
    /** @type {string[]} */
    const problems = [];
    if (view.menus.length !== expected.menus) problems.push(`새로 전달된 메뉴가 ${view.menus.length}개다(기대 ${expected.menus}개)`);
    if (view.pushes !== expected.pushes) problems.push(`${THEME_CHANNEL} 전달이 ${view.pushes}번이다(기대 ${expected.pushes}번)`);
    const latest = view.menus.at(-1);
    if (expected.checked !== undefined && latest !== undefined) {
      const item = lightItem(latest);
      if (item === undefined) problems.push(`새 메뉴에 '${LIGHT_LABEL}' 가 없다`);
      else if (item.checked !== expected.checked) problems.push(`새 메뉴의 '${LIGHT_LABEL}' 체크가 ${item.checked} 다(기대 ${expected.checked})`);
    }
    return problems;
  }

  /**
   * 테마 네 단계(theme 의 본문) — 문제는 단계 표식(①–④)을 붙여 problems 에, 통과 글은 notes 에 쌓는다. 단계는 모두 돈다(앞 단계가 틀려도 —
   * ③ ④ 가 상태를 dark 로 되돌리고, 실패 글이 단계마다 무엇이 어긋났는지 말한다). 창이 파괴됐으면 거기서 멈춘다.
   * @param {string[]} problems
   * @param {string[]} notes
   * @returns {Promise<void>}
   */
  async function themeSteps(problems, notes) {
    // ③ 의 낡은 메뉴 — ① 전의 최신 메뉴(dark 일 때 만든 것이라 '라이트 모드' 가 꺼져 있다)의 항목을 지금 잡아 둔다
    const staleItem = lightItem(ctx.menus.at(-1));
    const light = show(ctx.rgbOfHex(THEME_COLORS.light));
    const dark = show(ctx.rgbOfHex(THEME_COLORS.dark));

    // ① 페이지가 setTheme('light') → 장벽
    if (stopped(problems, '①')) return;
    const first = await observeTheme(() => ctx.page(themeScript('light'), "setTheme('light')"));
    problems.push(...labelled('①', [...themeStateProblems(first, 'light'), ...deliveryProblems(first, { menus: 1, pushes: 1, checked: true })]));
    const savedLight = await waitSaved('theme', 'light');
    if (savedLight !== null) problems.push(`① ${savedLight}`);
    notes.push(
      `① setTheme('light') → 스냅샷 · data-theme · tj_theme "light" · body 배경 = --bg = getBackgroundColor() = ${light} · 새 메뉴 1개('${LIGHT_LABEL}' 체크) · ${THEME_CHANNEL} 전달 1번 · settings.json "light"`,
    );

    // ② 받지 않는 값 — 아무것도 바뀌지 않는다(메모리 · 페이지 · 창. 파일은 보지 않는다)
    if (stopped(problems, '②')) return;
    const second = await observeTheme(() => ctx.page(themeScript('purple'), "setTheme('purple')"));
    problems.push(...labelled('②', [...unchangedProblems(second, first), ...deliveryProblems(second, { menus: 0, pushes: 0 })]));
    notes.push(`② setTheme('purple') → 그대로(메모리 · 페이지 · 창) · 새 메뉴 0개 · ${THEME_CHANNEL} 전달 0번`);

    // ③ ① 전의 낡은 메뉴의 '라이트 모드' — Electron 이 click 전에 체크를 뒤집어(false → true) '켜기' 가 되므로 light 그대로 + 새 메뉴
    if (stopped(problems, '③')) return;
    if (staleItem === undefined) {
      problems.push(`③ ① 전의 메뉴에 '${LIGHT_LABEL}' 가 없다 — 낡은 메뉴 단계를 하지 못함`);
    } else if (checkedNow(staleItem)) {
      problems.push(`③ ① 전의 메뉴의 '${LIGHT_LABEL}' 가 이미 체크돼 있다(dark 에서 만든 메뉴가 아니다) — 낡은 메뉴 단계를 증명하지 못함`);
    } else {
      const third = await observeTheme(async () => {
        staleItem.click();
        return ctx.page(themeScript(null), '낡은 메뉴 클릭 뒤 getState()');
      });
      if (!checkedNow(staleItem)) problems.push(`③ 낡은 메뉴의 '${LIGHT_LABEL}' 를 누른 뒤에도 그 항목의 checked 가 false 다(Electron 이 click 전에 뒤집지 않았다)`);
      problems.push(...labelled('③', [...themeStateProblems(third, 'light'), ...deliveryProblems(third, { menus: 1, pushes: 1, checked: true })]));
      notes.push(
        `③ ① 전의 낡은 메뉴의 '${LIGHT_LABEL}' 체크 false → true(Electron 이 click 전에 뒤집었다) → light 그대로 · 새 메뉴 1개('${LIGHT_LABEL}' 체크) · ${THEME_CHANNEL} 전달 1번`,
      );
    }

    // ④ 최신 메뉴의 '라이트 모드'(체크) — 뒤집혀 '끄기' → 모두 dark + 새 메뉴(체크 해제) + settings.json dark
    if (stopped(problems, '④')) return;
    const latestItem = lightItem(ctx.menus.at(-1));
    if (latestItem === undefined) {
      problems.push(`④ 최신 메뉴에 '${LIGHT_LABEL}' 가 없다`);
      return;
    }
    const fourth = await observeTheme(async () => {
      latestItem.click();
      return ctx.page(themeScript(null), '최신 메뉴 클릭 뒤 getState()');
    });
    problems.push(...labelled('④', [...themeStateProblems(fourth, 'dark'), ...deliveryProblems(fourth, { menus: 1, pushes: 1, checked: false })]));
    const savedDark = await waitSaved('theme', 'dark');
    if (savedDark !== null) problems.push(`④ ${savedDark}`);
    notes.push(`④ 최신 메뉴의 '${LIGHT_LABEL}' → 모두 "dark"(${dark}) · 새 메뉴 1개(체크 해제) · ${THEME_CHANNEL} 전달 1번 · settings.json "dark"`);
  }

  /**
   * theme(설계 §5.5 표) — ① 페이지가 setTheme('light') → getState() 장벽: 스냅샷 · data-theme · 저장값(tj_theme) light, body 배경 = --bg =
   * getBackgroundColor() = light 의 글자 값(모두 rgbOfHex 로 바꿔 견준다), 새로 전달된 메뉴 하나의 '라이트 모드' 체크, tj-theme 하나,
   * settings.json light(기다린다) ② setTheme('purple') → 장벽: ① 뒤와 하나도 다르지 않다(메모리 · 페이지 · 창 — 파일은 보지 않는다), 새 메뉴 ·
   * tj-theme 없음 ③ ① 전에 받아 둔 낡은 메뉴의 '라이트 모드'(꺼진 체크)를 누른다 → Electron 이 click 전에 체크를 뒤집어 '켜기' 가 되므로 light
   * 그대로 + 새 메뉴(체크) — 실제 Menu.buildFromTemplate 의 메뉴에서 그 뒤집기를 직접 본다 ④ 최신 메뉴의 '라이트 모드' → 모두 dark + 새 메뉴
   * (체크 해제) + settings.json dark. 끝에(실패 길에서도) 창을 main 의 길로 보인 채 둔다 — 못 하면 실패다(restoreShown).
   * @returns {Promise<CheckVerdict>}
   */
  async function theme() {
    /** @type {string[]} */
    const problems = [];
    /** @type {string[]} */
    const notes = [];
    try {
      await themeSteps(problems, notes);
    } finally {
      await restoreShown(problems, notes);
    }
    return verdictOf(problems, notes.join(' · '));
  }

  // ── opacity ────────────────────────────────────────────────────────

  /**
   * 투명도 표 한 줄 — 페이지가 setOpacity(보낼 값) → getState() 장벽. 실행기의 tj-set-opacity 수신 기록이 보낸 값 하나(NaN 은 'NaN')이고,
   * 스냅샷 opacity 와 round(getOpacity() × 100) 이 기대값이고, 저장값이 바뀌는 줄은 settings.json 이 그 값이 된다(기다린다). 문제 목록이다.
   * @param {OpacityRow} row
   * @returns {Promise<string[]>}
   */
  async function opacityRow(row) {
    const before = ctx.mark();
    const snapshot = await ctx.page(opacityScript(row.send), `setOpacity(${sentText(row.send)})`);
    /** @type {string[]} */
    const problems = [];
    const receipts = facts.opacityReceipts.slice(before.opacityReceipts).map((receipt) => receipt.value);
    const receipt = typeof row.send === 'number' && Number.isNaN(row.send) ? 'NaN' : row.send;
    if (receipts.length !== 1 || receipts[0] !== receipt) problems.push(`실행기의 tj-set-opacity 수신 기록이 ${show(receipts)} 다(기대 ${show([receipt])})`);
    const kept = isRecord(snapshot) ? snapshot.opacity : snapshot;
    if (kept !== row.expect) problems.push(`스냅샷 opacity 가 ${show(kept)} 다(기대 ${row.expect})`);
    const win = ctx.win();
    if (win.isDestroyed()) {
      problems.push('트레이 창이 파괴됐다 — getOpacity() 를 읽지 못함');
    } else {
      const percent = Math.round(win.getOpacity() * 100);
      if (percent !== row.expect) problems.push(`창 투명도 round(getOpacity() × 100) 이 ${percent} 다(기대 ${row.expect})`);
    }
    if (row.saves) {
      const saved = await waitSaved('opacity', row.expect);
      if (saved !== null) problems.push(saved);
    }
    return problems;
  }

  /**
   * opacity(설계 §5.5 표) — 실행기 안의 글자 표(OPACITY_TABLE)를 그 차례로 돈다(opacityRow). 한 줄이 어긋나면 거기서 멈춘다 — 뒤 줄은 앞
   * 줄이 남긴 값을 전제로 한다(잘못된 값은 64 에서 보낸다). 끝에(실패 길에서도) 창을 main 의 길로 보인 채 둔다 — 못 하면 실패다(restoreShown).
   * @returns {Promise<CheckVerdict>}
   */
  async function opacity() {
    /** @type {string[]} */
    const problems = [];
    /** @type {string[]} */
    const notes = [];
    try {
      for (const row of OPACITY_TABLE) {
        const label = rowLabel(row);
        if (stopped(problems, label)) break;
        const rowProblems = await opacityRow(row);
        if (rowProblems.length > 0) {
          problems.push(...rowProblems.map((problem) => `${label}: ${problem}`));
          break;
        }
      }
    } finally {
      await restoreShown(problems, notes);
    }
    const saved = OPACITY_TABLE.filter((row) => row.saves).map((row) => row.expect);
    return verdictOf(problems, [
      `${OPACITY_TABLE.map(rowLabel).join(' · ')} — 줄마다 수신 기록 = 보낸 값(NaN 은 "NaN") · 스냅샷 opacity = round(getOpacity() × 100) = 기대값 · 저장값이 바뀐 줄의 settings.json opacity ${saved.join(' → ')}`,
      ...notes,
    ].join(' · '));
  }

  // ── escHide · visibility 공용 ───────────────────────────────────────

  /**
   * 창 기록 한 건이 숨김인가.
   * @param {WindowFact} entry
   * @returns {boolean}
   */
  function isHide(entry) {
    return entry.action === 'hide';
  }

  /**
   * from 자리 뒤의(to 를 주면 그 자리 앞까지의) 숨김 기록.
   * @param {FactMark} from
   * @param {FactMark} [to]
   * @returns {WindowFact[]}
   */
  function hidesBetween(from, to) {
    return facts.window.slice(from.window, to?.window).filter(isHide);
  }

  /**
   * from 자리 뒤의 창 기록(action:reason 목록의 값 표현) — 실패 글에 싣는다.
   * @param {FactMark} from
   * @returns {string}
   */
  function trailSince(from) {
    return show(ctx.windowTrail(facts.window.slice(from.window)));
  }

  /**
   * from 자리 뒤에 실행기가 받은 tj-hide 수.
   * @param {FactMark} from
   * @returns {number}
   */
  function receiptsSince(from) {
    return facts.hideReceipts.length - from.hideReceipts;
  }

  /**
   * from 자리 뒤에 main 이 channel 을 민 수.
   * @param {FactMark} from
   * @param {string} channel
   * @returns {number}
   */
  function pushesSince(from, channel) {
    return facts.sent.slice(from.sent).filter((entry) => entry.channel === channel).length;
  }

  /**
   * 숨김 기록이 정확히 하나이고 그 이유가 reason 인가 — 맞으면 null, 아니면 그 문제(what 은 앞에 붙는 말).
   * @param {readonly WindowFact[]} hides
   * @param {string} reason
   * @param {string} [what]
   * @returns {string | null}
   */
  function oneHideProblem(hides, reason, what = '') {
    if (hides.length === 1 && hides[0]?.reason === reason) return null;
    return `${what}숨김 기록이 ${show(ctx.windowTrail(hides))} 다(기대 하나 — 이유 ${show(reason)})`;
  }

  /**
   * 이 검사가 일으키지 않은 숨김(R14) — from 자리 뒤에 숨김 기록이 있으면 첫 것의 이유를 적은 문제(what 은 앞에 붙는 말), 없으면 null.
   * @param {FactMark} from
   * @param {string} [what]
   * @returns {string | null}
   */
  function strayHide(from, what = '') {
    const [stray] = hidesBetween(from);
    return stray === undefined ? null : `${what}우연한 숨김(이유 ${show(stray.reason)}) — 이 검사가 일으키지 않은 숨김이다(새 창 기록 ${trailSince(from)})`;
  }

  /**
   * main 의 길로 연다(openViaMain) — 동기로 누르고 기다리지 않는다(보였는지는 waitShown 으로 본다). 창이 파괴됐으면 누르지 않는다.
   * @returns {OpenPress}
   */
  function pressOpen() {
    const from = ctx.mark();
    const { how, missing } = ctx.openPath();
    return { from, how, missing, pressed: destroyed() === null && ctx.openViaMain() };
  }

  /**
   * from 자리 뒤에 창이 보이고 그 보이기 기록이 올 때까지 WAIT_MS 까지 기다린다 — 그 기록, 아니면 null(시간 초과 · 창 파괴 — 던지지 않는다).
   * @param {FactMark} from
   * @returns {Promise<WindowFact | null>}
   */
  async function waitShown(from) {
    const shown = () => (destroyed() === null && ctx.win().isVisible() ? facts.window.slice(from.window).find((entry) => entry.action === 'show') : undefined);
    await until(() => destroyed() !== null || shown() !== undefined, WAIT_MS);
    return shown() ?? null;
  }

  /**
   * 페이지 호출을 기다리지 않고 시작한다 — 끝나면 outcome() 이 그 모양이고 settled 가 풀린다(거부하지 않는다 — 동기로 던져도 거부로 적는다).
   * @param {string} code
   * @param {string} what
   * @returns {{ settled: Promise<void>, outcome: () => PageOutcome | null }}
   */
  function startPage(code, what) {
    /** @type {{ outcome: PageOutcome | null }} 콜백이 바꾼다(지역 변수는 TS 흐름 분석이 콜백의 변경을 놓친다) */
    const box = { outcome: null };
    /** @type {Promise<unknown>} */
    let call;
    try {
      call = ctx.page(code, what);
    } catch (error) {
      call = Promise.reject(error);
    }
    const settled = call.then(
      (value) => {
        box.outcome = { kind: 'resolved', value };
      },
      (error) => {
        box.outcome = { kind: 'rejected', error };
      },
    );
    return { settled, outcome: () => box.outcome };
  }

  // ── escHide ────────────────────────────────────────────────────────

  /**
   * 숨지 않아야 할 Esc 한 단계(① ②) — 페이지가 Esc 를 보내고 장벽(getState)을 지난 답을 받은 뒤, 그 사이 tj-hide 수신과 숨김 기록이 없고 창이
   * 보이는지 본다(장벽이 '숨지 않음' 의 양성 기록이다). 숨었는데 tj-hide 를 받았으면 이 Esc 가 숨긴 것이고(대화상자가 있는데 숨음), 받지 않았으면
   * 이 검사가 일으키지 않은 숨김이다(R14). 페이지의 답, 아니면 null — 문제를 적었다(검사를 멈춘다: 뒤 단계는 보이는 창을 전제로 한다).
   * @param {'①' | '②'} label
   * @param {'open' | 'closes'} dialog
   * @param {string[]} problems
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function escKeepsShown(label, dialog, problems) {
    if (stopped(problems, label)) return null;
    const before = ctx.mark();
    const seen = await ctx.page(escScript(dialog), `Esc(${label})`);
    if (stopped(problems, label, '도중에')) return null;
    const receipts = receiptsSince(before);
    if (receipts > 0) {
      problems.push(`${label} 대화상자(aria-modal)가 열려 있는데 Esc 로 숨었다 — tj-hide 수신 ${receipts}번 · 새 창 기록 ${trailSince(before)}`);
      return null;
    }
    const stray = strayHide(before, `${label} `);
    if (stray !== null) {
      problems.push(stray);
      return null;
    }
    if (!ctx.win().isVisible()) {
      problems.push(`${label} 창이 보이지 않는다(숨김 기록 없이 — 새 창 기록 ${trailSince(before)})`);
      return null;
    }
    if (!isRecord(seen)) {
      problems.push(`${label} 페이지 사실이 객체가 아니다: ${show(seen)}`);
      return null;
    }
    return seen;
  }

  /**
   * escHide 의 본문 — 문제는 단계 표식(①–④)을 붙여 problems 에, 통과 글은 notes 에 쌓는다. 시작 때 창이 보여야 하고(R14 — 앞 검사가 남긴
   * 창 기록은 보지 않는다), ① ② 는 숨지 않아야 하며(어긋나면 멈춘다), ③ 에서 숨고 ④ 에서 다시 연다.
   * @param {string[]} problems
   * @param {string[]} notes
   * @returns {Promise<void>}
   */
  async function escSteps(problems, notes) {
    if (stopped(problems, '시작')) return;
    if (!ctx.win().isVisible()) {
      problems.push(`시작 때 창이 보이지 않는다(마지막 창 기록 ${show(ctx.windowTrail())}) — 검사를 하지 못함`);
      return;
    }
    // ① 대화상자(aria-modal 요소)가 열린 채 Esc — 장벽 뒤에도 숨지 않는다
    const first = await escKeepsShown('①', 'open', problems);
    if (first === null) return;
    if (first.dialog !== true) {
      problems.push(`① Esc 를 보낼 때 aria-modal 요소가 없었다(${show(first.dialog)}) — 대화상자 단계를 증명하지 못함`);
      return;
    }
    notes.push('① aria-modal 요소가 있는 채 Esc → 장벽 뒤 숨김 0 · tj-hide 수신 0');
    // ② 같은 요소 + 그것을 동기로 지우는 #root keydown 리스너(React 커밋 대신 — 버블 길에서 window 보다 먼저 돈다). 시작 때의 대화상자로
    // 정하는 렌더러는 리스너 등록 순서와 상관없이 숨지 않는다
    const second = await escKeepsShown('②', 'closes', problems);
    if (second === null) return;
    if (second.dialog !== true || second.ran !== true || second.removed !== true) {
      problems.push(
        `② #root keydown 리스너가 aria-modal 요소를 지우지 않았다(보낼 때 요소 ${show(second.dialog)} · 리스너 ${show(second.ran)} · 지움 ${show(second.removed)}) — 등록 순서와 상관없음을 증명하지 못함`,
      );
      return;
    }
    notes.push('② 그 요소를 #root keydown 리스너가 동기로 지웠다(돌았다) → 창은 그대로 보임(시작 때의 대화상자로 정한다 — 등록 순서와 상관없다)');
    await escHideAndReopen(problems, notes);
  }

  /**
   * ③ 요소 없이 Esc → tj-hide 수신 1 · 숨김 1('request') · 파괴 안 됨 · 페이지 응답(R15 — 설계 §5.5 그대로. tj-hidden 전달은 visibility ① 이
   * 본다) ④ 다시 보인다 — 'request' 숨김 기록을 보자마자, 페이지의 답(숨은 창의 페이지는 느릴 수 있다)보다 먼저 main 의 길로 연다(escReopened).
   * 'request' 숨김이 없으면 ④ 를 하지 않는다(③ 이 적었다 — 숨어 있으면 끝이 다시 연다).
   * @param {string[]} problems
   * @param {string[]} notes
   * @returns {Promise<void>}
   */
  async function escHideAndReopen(problems, notes) {
    if (stopped(problems, '③')) return;
    const before = ctx.mark();
    const call = startPage(escScript('none'), 'Esc(③)');
    const requestHide = () => hidesBetween(before).find((entry) => entry.reason === 'request');
    await until(() => destroyed() !== null || requestHide() !== undefined || call.outcome() !== null, PAGE_MS);
    const hide = destroyed() === null ? requestHide() : undefined;
    // ④ 를 누른다 — 기다리지 않는다(win32 는 경합 창 안의 트레이 클릭이어야 한다)
    const open = hide === undefined ? null : pressOpen();
    await call.settled;
    if (stopped(problems, '③', '도중에')) return;
    const count = problems.length;
    const outcome = call.outcome();
    if (outcome === null || outcome.kind === 'rejected') {
      problems.push(`③ 페이지가 응답하지 않았다(${outcome === null ? '끝나지 않았다' : errorText(outcome.error)})`);
    } else if (!isRecord(outcome.value)) {
      problems.push(`③ 페이지 사실이 객체가 아니다: ${show(outcome.value)}`);
    } else if (outcome.value.dialog !== false) {
      problems.push(`③ Esc 를 보낼 때 aria-modal 요소가 있었다(${show(outcome.value.dialog)}) — 대화상자 없는 단계가 아니다`);
    }
    const receipts = receiptsSince(before);
    if (receipts !== 1) problems.push(`③ tj-hide 수신이 ${receipts}번이다(기대 1번)`);
    const wrong = oneHideProblem(hidesBetween(before, open?.from), 'request', '③ ');
    if (wrong !== null) problems.push(wrong);
    if (problems.length === count) notes.push('③ 요소 없이 Esc → tj-hide 수신 1 · 숨김 1(request) · 파괴 안 됨 · 페이지 응답');
    if (hide !== undefined && open !== null) await escReopened(problems, notes, hide, open);
  }

  /**
   * ④ 의 판정 — 누른 뒤 창이 보이고 그 보이기 기록이 와야 한다(WAIT_MS). win32 는 트레이 클릭이고, 기록으로 클릭.at − 숨김.at < CLICK_RACE_MS
   * 를 단언한다 — 경합 창 안의 클릭이 열어야 Esc 숨김이 경합 가드를 켜지 않았다는 증명이 된다(가드는 blur 숨김에만). 그 밖은 메뉴의
   * '열기'(클릭 처리기 · 경합 가드가 없다). 다시 보인 뒤의 숨김은 이 검사가 일으키지 않은 것이다(R14).
   * @param {string[]} problems
   * @param {string[]} notes
   * @param {WindowFact} hide ③ 의 'request' 숨김 기록
   * @param {OpenPress} open
   * @returns {Promise<void>}
   */
  async function escReopened(problems, notes, hide, open) {
    if (!open.pressed) {
      problems.push(`④ ${open.missing} — 숨긴 창을 main 의 길로 다시 열 수 없다`);
      return;
    }
    const shown = await waitShown(open.from);
    if (stopped(problems, '④', '도중에')) return;
    const count = problems.length;
    /** @type {string | null} win32 — 'request' 숨김 기록에서 트레이 클릭까지 */
    let gap = null;
    if (ctx.platform === 'win32') {
      const click = ctx.trayClicks.slice(open.from.trayClicks)[0];
      if (click === undefined) {
        problems.push('④ 트레이 클릭 기록이 없다 — 경합 창 안의 클릭이었는지 잴 수 없다');
      } else {
        gap = `${(click.at - hide.at).toFixed(1)}ms`;
        if (!(click.at - hide.at < CLICK_RACE_MS)) {
          problems.push(`④ 트레이 클릭이 'request' 숨김 기록 ${gap} 뒤였다(경합 시간 ${CLICK_RACE_MS}ms 안이어야 한다) — Esc 숨김이 경합 가드를 켜지 않음을 증명하지 못함`);
        }
      }
    }
    if (shown === null) {
      problems.push(`④ ${open.how} 뒤 ${WAIT_MS}ms 안에 창이 보이지 않았다(보임 ${ctx.win().isVisible()} · 새 창 기록 ${trailSince(open.from)})`);
      return;
    }
    const stray = strayHide(open.from, '④ 다시 보인 뒤 ');
    if (stray !== null) problems.push(stray);
    if (problems.length > count) return;
    notes.push(
      gap === null
        ? `④ ${open.how} → 보임(${shown.reason})`
        : `④ 'request' 숨김 기록 ${gap} 뒤 ${open.how} → 보임(${shown.reason}) — 경합 시간(${CLICK_RACE_MS}ms) 안의 클릭이 열었다: Esc 숨김은 경합 가드를 켜지 않는다`,
    );
  }

  /**
   * escHide(설계 §5.5 표) — ① aria-modal 요소를 넣고 페이지에서 Esc → 장벽 → 숨김 0 · tj-hide 수신 0 ② 같은 요소 + 그것을 동기로 지우는 #root
   * keydown 리스너 → #root 안에서 Esc → 요소가 지워졌고(양성 기록 — 리스너가 돌았다) 창은 그대로 보임(등록 순서와 상관없음) ③ 요소 없이 Esc →
   * tj-hide 수신 1 · 숨김 1('request') · 파괴 안 됨 · 페이지 응답 ④ 다시 보인다(win32 는 경합 창 안의 트레이 클릭). Esc 는 페이지에서 만든 키
   * 이벤트다(sendInputEvent 는 창 포커스가 필요하다 — 실제 키 경로는 손으로 본다, 설계 §5.5 [결정]). 끝에(실패 길에서도) 창을 main 의 길로
   * 보인 채 둔다 — 못 하면 실패다(restoreShown).
   * @returns {Promise<CheckVerdict>}
   */
  async function escHide() {
    /** @type {string[]} */
    const problems = [];
    /** @type {string[]} */
    const notes = [];
    try {
      await escSteps(problems, notes);
    } finally {
      await restoreShown(problems, notes);
    }
    return verdictOf(problems, notes.join(' · '));
  }

  // ── visibility ─────────────────────────────────────────────────────

  /**
   * 페이지의 <html> tapp-hidden · visibilityState — 모양이 아니면 null.
   * @returns {Promise<HiddenState | null>}
   */
  async function hiddenState() {
    const seen = await ctx.page(HIDDEN_STATE_SCRIPT, 'tapp-hidden · visibilityState');
    return isRecord(seen) && typeof seen.hiddenClass === 'boolean' ? { hiddenClass: seen.hiddenClass, visibilityState: seen.visibilityState } : null;
  }

  /**
   * <html> 의 tapp-hidden 이 want 가 될 때까지 ms(기본 WAIT_MS)까지 페이지를 다시 읽는다(렌더러는 tj-hidden · tj-shown push 로 단다). 창이
   * 파괴되면 그만 기다린다(R29 — 그 페이지 호출이 파괴로 거부돼도 같다. 그 밖의 거부는 그 단계의 실패다). 페이지가 답한 수와 마지막 답의
   * 때도 돌려준다 — 되지 않았을 때 '한 번도 답하지 않았다' 와 '답했지만 붙지 · 빠지지 않았다' 를 가른다(classMiss). ms 는 페이지 호출 한
   * 번의 상한(PAGE_MS)을 넘지 않는다 — 넘으면 그 호출의 거부가 기다림의 시간 초과보다 먼저 와서 판정 대신 단계의 실패가 된다.
   * @param {boolean} want
   * @param {number} [ms]
   * @returns {Promise<ClassWait>}
   */
  async function waitHiddenClass(want, ms = WAIT_MS) {
    /** @type {{ last: HiddenState | null, answers: number, lastAt: number | null }} 콜백이 바꾼다(지역 변수는 TS 흐름 분석이 콜백의 변경을 놓친다) */
    const seen = { last: null, answers: 0, lastAt: null };
    const done = await untilAsync(
      async () => {
        if (destroyed() !== null) return true;
        try {
          seen.last = await hiddenState();
        } catch (err) {
          if (destroyed() !== null) return true;
          throw err;
        }
        seen.answers += 1;
        seen.lastAt = performance.now();
        return seen.last?.hiddenClass === want;
      },
      ms,
      `<html> 의 tapp-hidden 을 기다리기(${want ? '붙기' : '빠지기'})`,
    );
    const { last, answers, lastAt } = seen; // 상한 뒤에 늦게 온 답은 넣지 않는다
    return { want, ms, ok: done && destroyed() === null && last?.hiddenClass === want, answers, last, lastAt };
  }

  /**
   * ① 진짜 ✕ 단추를 페이지에서 누른다 → tj-hide 수신 1 · 숨김 1('request') · 새 tj-hidden 전달 1 · <html> 에 tapp-hidden ·
   * getBackgroundThrottling() === true(기본 켬) · 파괴 안 됨 → 그 숨김에서 경합 시간 + 여유가 지난 뒤(R13) main 의 길로 다시 연다 → tj-shown 전달
   * 1 · 클래스 빠짐. 숨긴(스로틀 켠) 창의 tapp-hidden 은 페이지 호출 한 번의 상한(PAGE_MS)까지 읽고, ✕ 의 답과 tapp-hidden 을 본 때(못 봤으면
   * 마지막 답)를 숨김 기록에서 재어 통과 · 실패 글에 싣는다 — 숨긴 창의 렌더러는 늦을 수 있어(실측 한 번 약 3초) 흔들리면 이 값으로 늦음과
   * 결함을 가른다. 문제는 ① 표식을 붙여 problems 에. ② 를 해도 되면(창이 살아 있고 보인다) true.
   * @param {string[]} problems
   * @param {string[]} notes
   * @returns {Promise<boolean>}
   */
  async function hideButtonRound(problems, notes) {
    if (stopped(problems, '①')) return false;
    const count = problems.length;
    /** @param {string} text */
    const fail = (text) => problems.push(`① ${text}`);
    const before = ctx.mark();
    const pressed = await ctx.page(HIDE_BUTTON_SCRIPT, '✕(숨기기) 클릭');
    const answeredAt = performance.now();
    if (stopped(problems, '①', '도중에')) return false;
    if (!isRecord(pressed) || pressed.found !== true) {
      fail(`✕ 단추(button[aria-label="숨기기"])를 찾지 못했다: ${show(pressed)}`);
      return ctx.win().isVisible();
    }
    const receipts = receiptsSince(before);
    if (receipts !== 1) fail(`tj-hide 수신이 ${receipts}번이다(기대 1번)`);
    const early = hidesBetween(before).at(-1);
    if (early === undefined) {
      fail(`숨김 기록이 없다 — ✕ 로 창이 숨지 않았다(보임 ${ctx.win().isVisible()})`);
      return ctx.win().isVisible();
    }
    const added = await waitHiddenClass(true, PAGE_MS);
    if (stopped(problems, '①', '도중에')) return false;
    const hideAt = early.at;
    /** @param {number} at 숨김 기록에서 그때까지 */
    const sinceHide = (at) => `${(at - hideAt).toFixed(1)}ms`;
    const answered = `숨김 기록 뒤 ✕ 응답 ${sinceHide(answeredAt)}`;
    // 전달 수는 클래스를 기다린 뒤에 센다 — main 은 창의 hide 사건에서 밀고 그 뒤에 기록하며, 렌더러는 받은 뒤에야 클래스를 단다(그 사건이
    // 늦게 와도 헛실패하지 않는다)
    const pushed = pushesSince(before, HIDDEN_CHANNEL);
    if (pushed !== 1) fail(`새 ${HIDDEN_CHANNEL} 전달이 ${pushed}번이다(기대 1번)`);
    if (!added.ok) fail(classMiss(added, added.lastAt === null ? [answered] : [answered, `마지막 답 ${sinceHide(added.lastAt)}`]));
    const throttling = ctx.win().webContents.getBackgroundThrottling();
    if (throttling !== true) fail(`숨긴 동안 getBackgroundThrottling() 이 ${show(throttling)} 다(기대 true — 기본 켬)`);
    // 그 숨김에서 경합 시간 + 여유가 지난 뒤 다시 연다(R13 — 경합 창은 tray · escHide ④ 만 잰다)
    await waitElapsed(early.at, CLICK_RACE_MS + ctx.timingMarginMs);
    if (stopped(problems, '①', '도중에')) return false;
    const waited = `${(performance.now() - early.at).toFixed(1)}ms`;
    const open = pressOpen();
    const wrong = oneHideProblem(hidesBetween(before, open.from), 'request');
    if (wrong !== null) fail(wrong);
    if (!open.pressed) {
      fail(`${open.missing} — 숨긴 창을 main 의 길로 다시 열 수 없다`);
      return false;
    }
    const shown = await waitShown(open.from);
    if (stopped(problems, '①', '다시 연 뒤')) return false;
    if (shown === null) {
      fail(`${open.how} 뒤 ${WAIT_MS}ms 안에 창이 보이지 않았다(보임 ${ctx.win().isVisible()} · 새 창 기록 ${trailSince(open.from)})`);
      return false;
    }
    const removed = await waitHiddenClass(false);
    if (stopped(problems, '①', '다시 연 뒤')) return false;
    const shownPushes = pushesSince(open.from, SHOWN_CHANNEL); // 클래스를 기다린 뒤에 센다(위의 tj-hidden 과 같다)
    if (shownPushes !== 1) fail(`다시 보인 뒤 ${SHOWN_CHANNEL} 전달이 ${shownPushes}번이다(기대 1번)`);
    if (!removed.ok) fail(`다시 보인 뒤 ${classMiss(removed)}`);
    const stray = strayHide(open.from, '다시 보인 뒤 ');
    if (stray !== null) {
      fail(stray);
      return false;
    }
    if (problems.length === count) {
      const seenAt = added.lastAt === null ? '?' : sinceHide(added.lastAt); // 통과했으면 답이 있었다
      notes.push(
        `① ✕ → tj-hide 수신 1 · 숨김 1(request) · ${HIDDEN_CHANNEL} 전달 1 · <html> tapp-hidden · getBackgroundThrottling() true · 파괴 안 됨 · ${answered} · tapp-hidden 확인 ${seenAt} → ${waited} 뒤 ${open.how} → 보임(${shown.reason}) · ${SHOWN_CHANNEL} 전달 1 · tapp-hidden 빠짐`,
      );
    }
    return true;
  }

  /**
   * ② 스로틀 끈 한 바퀴 — 실행기가 setBackgroundThrottling(false) → win.close()(OS 닫기 경로 — 숨김 이유 'close') → 페이지의 visibilityState 가
   * 'visible' 인데(양성 기록 — 스로틀을 끈 숨긴 창은 visible 이다) <html> 에 tapp-hidden 이 붙는다(visibilitychange 로 움직이는 렌더러를 걸러
   * 낸다) → 그 숨김에서 경합 시간 + 여유가 지난 뒤 다시 연다 → 빠짐 → setBackgroundThrottling(true) · getBackgroundThrottling() === true. 끈
   * 스로틀은 throttle.off 로 알린다(다시 켜기 전에 멈추면 끝이 켠다). 문제는 ② 표식을 붙여 problems 에.
   * @param {string[]} problems
   * @param {string[]} notes
   * @param {{ off: boolean }} throttle
   * @returns {Promise<void>}
   */
  async function throttledRound(problems, notes, throttle) {
    if (stopped(problems, '②')) return;
    const count = problems.length;
    /** @param {string} text */
    const fail = (text) => problems.push(`② ${text}`);
    const before = ctx.mark();
    const win = ctx.win();
    win.webContents.setBackgroundThrottling(false);
    throttle.off = true;
    win.close();
    await until(() => destroyed() !== null || hidesBetween(before).length > 0, WAIT_MS);
    if (stopped(problems, '②', 'win.close() 뒤')) return;
    const early = hidesBetween(before).at(-1);
    if (early === undefined) {
      fail(`win.close() 뒤 ${WAIT_MS}ms 안에 숨김 기록이 없다(보임 ${ctx.win().isVisible()})`);
      return;
    }
    const added = await waitHiddenClass(true);
    if (stopped(problems, '②', '도중에')) return;
    const visibilityState = added.last?.visibilityState;
    if (visibilityState !== 'visible') {
      fail(`스로틀을 끈 숨긴 창의 visibilityState 가 ${show(visibilityState)} 다(기대 "visible" — 양성 기록이 없어 visibilitychange 로 움직이는 렌더러를 가르지 못함)`);
    }
    if (!added.ok) fail(`visibilityState ${show(visibilityState)} 인 채 ${classMiss(added, [`렌더러는 visibilitychange 가 아니라 ${HIDDEN_CHANNEL} 으로 단다`])}`);
    // 그 숨김에서 경합 시간 + 여유가 지난 뒤 다시 연다(R13)
    await waitElapsed(early.at, CLICK_RACE_MS + ctx.timingMarginMs);
    if (stopped(problems, '②', '도중에')) return;
    const waited = `${(performance.now() - early.at).toFixed(1)}ms`;
    const open = pressOpen();
    const wrong = oneHideProblem(hidesBetween(before, open.from), 'close', 'win.close() 뒤 ');
    if (wrong !== null) fail(wrong);
    if (!open.pressed) {
      fail(`${open.missing} — 숨긴 창을 main 의 길로 다시 열 수 없다`);
      return;
    }
    const shown = await waitShown(open.from);
    if (stopped(problems, '②', '다시 연 뒤')) return;
    if (shown === null) {
      fail(`${open.how} 뒤 ${WAIT_MS}ms 안에 창이 보이지 않았다(보임 ${ctx.win().isVisible()} · 새 창 기록 ${trailSince(open.from)})`);
      return;
    }
    const removed = await waitHiddenClass(false);
    if (stopped(problems, '②', '다시 연 뒤')) return;
    if (!removed.ok) fail(`다시 보인 뒤 ${classMiss(removed)}`);
    const contents = ctx.win().webContents;
    contents.setBackgroundThrottling(true);
    throttle.off = false;
    const back = contents.getBackgroundThrottling();
    if (back !== true) fail(`setBackgroundThrottling(true) 뒤 getBackgroundThrottling() 이 ${show(back)} 다 — 스로틀이 돌아오지 않았다`);
    const stray = strayHide(open.from, '다시 보인 뒤 ');
    if (stray !== null) fail(stray);
    if (problems.length === count) {
      notes.push(
        `② 스로틀 끔 → win.close() → 숨김(close) · visibilityState "visible" 인데 tapp-hidden → ${waited} 뒤 ${open.how} → 보임(${shown.reason}) · tapp-hidden 빠짐 → 스로틀 켬 · getBackgroundThrottling() true`,
      );
    }
  }

  /**
   * visibility 의 본문 — 보인 기록이 이미 있고(visibilityState 는 처음 보이기 전에는 숨어도 visible 이다 — 설계 §5.5) 시작 때 창이 보여야 한다
   * (R14). 시작 때 <html> 에 tapp-hidden 이 없어야 ① 의 '붙음' 이 뜻이 있다(있으면 적고 계속한다). ① 뒤 창이 살아 있고 보이면 ② 를 한다.
   * @param {string[]} problems
   * @param {string[]} notes
   * @param {{ off: boolean }} throttle
   * @returns {Promise<void>}
   */
  async function visibilitySteps(problems, notes, throttle) {
    if (stopped(problems, '시작')) return;
    if (!facts.window.some((entry) => entry.action === 'show')) {
      problems.push('보인 기록이 아직 없다 — 처음 보이기 전의 visibilityState 는 숨어도 visible 이라 양성 기록이 되지 않는다(검사를 하지 못함)');
      return;
    }
    if (!ctx.win().isVisible()) {
      problems.push(`시작 때 창이 보이지 않는다(마지막 창 기록 ${show(ctx.windowTrail())}) — 검사를 하지 못함`);
      return;
    }
    const start = ctx.mark();
    const initial = await hiddenState();
    if (stopped(problems, '시작', '도중에')) return;
    const stray = strayHide(start, '시작 때 ');
    if (stray !== null) {
      problems.push(stray);
      return;
    }
    if (initial?.hiddenClass === false) notes.push('보인 기록 있음 · 시작 때 보이고 tapp-hidden 없음');
    else problems.push(`시작 때 <html> 의 tapp-hidden 이 ${show(initial?.hiddenClass)} 다 — 보이는 창에는 없어야 한다(① 의 '붙음' 이 뜻이 없다)`);
    if (await hideButtonRound(problems, notes)) await throttledRound(problems, notes, throttle);
  }

  /**
   * 검사의 끝 — 이 검사가 끈 스로틀을 아직 켜지 않았으면 켜고(창이 살아 있을 때만), 그래도 켜지지 않으면 그 검사의 실패로 적는다(뒤 검사와 앱은
   * 기본 스로틀을 전제로 한다).
   * @param {string[]} problems
   * @param {{ off: boolean }} throttle
   */
  function restoreThrottling(problems, throttle) {
    if (!throttle.off || destroyed() !== null) return;
    const contents = ctx.win().webContents;
    contents.setBackgroundThrottling(true);
    throttle.off = false;
    if (contents.getBackgroundThrottling() !== true) problems.push('끝에 끈 스로틀을 다시 켜지 못했다(setBackgroundThrottling(true) 뒤에도 getBackgroundThrottling() 이 true 가 아니다)');
  }

  /**
   * visibility(설계 §5.5 표) — 보인 기록이 이미 있음을 확인 → ① 진짜 ✕ 단추(hideButtonRound) ② 스로틀 끈 한 바퀴(throttledRound). 렌더러는
   * tj-hidden · tj-shown 으로만 tapp-hidden 을 바꾼다(visibilitychange 는 쓰지 않는다 — ② 가 그것을 가른다). 숨긴 동안 capturePage 를 하지
   * 않는다. 끝에(실패 길에서도) 이 검사가 끈 스로틀을 다시 켜고(restoreThrottling) 창을 main 의 길로 보인 채 둔다 — 못 하면 실패다(restoreShown).
   * @returns {Promise<CheckVerdict>}
   */
  async function visibility() {
    /** @type {string[]} */
    const problems = [];
    /** @type {string[]} */
    const notes = [];
    /** 이 검사가 끈 스로틀 — 다시 켜기 전에 멈추면 끝이 켠다 */
    const throttle = { off: false };
    try {
      await visibilitySteps(problems, notes, throttle);
    } finally {
      restoreThrottling(problems, throttle);
      await restoreShown(problems, notes);
    }
    return verdictOf(problems, notes.join(' · '));
  }

  return { theme, opacity, escHide, visibility };
}

module.exports = { createWindowChecks };
