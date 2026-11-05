'use strict';
// 창 검사(#21 설계 §5.5 '새 필수 검사') — 실행기(run.cjs)가 screenshot 바로 뒤에 theme → opacity 차례로 부른다(escHide · visibility 는 그
// 뒤에 Task 13 이 더한다). 페이지의 브리지 send 와 main 의 길(트레이 메뉴 클릭)로 창 상태를 바꾸고, 메모리(getState 스냅샷) · 페이지 · 창 ·
// 설정 파일 · 실행기의 기록(main 이 넘긴 메뉴 · 민 채널 · 수신 기록)으로 판정한다.
// - 순서 장벽은 페이지의 `await tjDesktop.getState()` 다 — 같은 프레임의 IPC 라 앞의 send 와 main 이 민 push 가 응답보다 먼저 처리된다
//   (설계 §5.3 의 추론 — theme ① 이 실제 앱에서 처음 증명한다). 저장 예약(300ms)을 기다리지 않는 판정은 메모리 값(스냅샷)으로 한다.
// - 색 · 투명도의 기대값은 여기 적은 글자다(설계 §5.1 · §5.5 — lib 값으로 계산하지 않는다: 같은 값을 두 곳이 계산하면 틀려도 같다).
// - 기다림(settings.json)의 시간 초과는 그 검사의 판정(ok false · detail)이다 — 던지지 않는다(R12). 창 · webContents 가 파괴됐으면 만지지
//   않고 판정으로 적은 뒤 그 검사를 멈춘다(R29 — 파괴된 창을 만지면 던져서 실행 전체가 stage 실패가 된다).
// - 각 검사는 끝에 — 실패 길에서도(finally) — 창을 main 의 길로 보인 채 돌려놓는다(R13 — 실행기의 endShown). theme · opacity 에는 '우연한
//   숨김' 규칙을 두지 않는다(보임과 상관없는 검사라 흔들림만 늘린다). 스모크에서 창을 고정하지 않는다(고정은 저장되고 tray 가 체크 false 를
//   요구한다).
// - 실행기의 사실 · 도우미(createSmokeRun 의 클로저)는 ctx 로 받는다 — 능동 검사의 ActiveContext 와 같은 모양이고 베끼지 않는다. 공용
//   도우미(support.cjs)와 페이지 코드(pageScripts.cjs)는 active.cjs 처럼 직접 가져온다. run.cjs 는 require 하지 않는다(순환). electron 도
//   require 하지 않는다.

const { isRecord } = require('../lib/guards.cjs');
const { opacityScript, themeScript } = require('./pageScripts.cjs');
const { WAIT_MS, show, until, verdictOf } = require('./support.cjs');

/**
 * 테마별 창 배경색 — 설계 §5.1 의 THEME_BACKGROUND 를 글자 그대로 적는다(lib/theme.cjs 에서 가져오지 않는다). body 배경 · --bg ·
 * getBackgroundColor() 를 모두 rgbOfHex 로 바꿔 이 값과 견준다.
 */
const THEME_COLORS = Object.freeze({ dark: '#0d1117', light: '#f5f6f8' });
/** 트레이 메뉴의 테마 항목(설계 §5.1 표의 글자). */
const LIGHT_LABEL = '라이트 모드';
/** main 이 테마를 렌더러에 미는 채널(설계 §5.3). */
const THEME_CHANNEL = 'tj-theme';
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
/** @typedef {'dark' | 'light'} Theme */
/**
 * 투명도 표 한 줄.
 * @typedef {{ send: unknown, expect: number, saves: boolean }} OpacityRow
 */
/**
 * 창 검사가 실행기에서 받는 것 — 실행기(createSmokeRun)가 가진 사실과 도우미(클로저)를 그대로 넘긴다(능동 검사의 ActiveContext 와 같은
 * 모양). theme · opacity 가 쓰는 것과 escHide · visibility(Task 13)가 쓸 것(hideViaMain · clickTray · windowTrail · timingMarginMs)을 함께 둔다.
 * @typedef {object} WindowContext
 * @property {import('./support.cjs').SmokeFacts} facts 수집한 사실 — window · sent · hideReceipts · opacityReceipts …
 * @property {string} platform main 이 넘긴 platform(process.platform 을 새로 읽지 않는다)
 * @property {() => import('electron').BrowserWindow} win 트레이 창
 * @property {readonly import('electron').Menu[]} menus main 이 setTray 로 넘긴 트레이 메뉴(넘긴 차례 — 맨 뒤가 최신이다. 실행기가 뒤에 쌓는다)
 * @property {(code: string, what: string, options?: import('./active.cjs').PageOptions) => Promise<unknown>} page main world 에서 돌린 값(상한이 있다)
 * @property {() => import('./run.cjs').FactMark} mark 사실 목록의 길이 — 그 뒤에 온 것만 보려면 목록.slice(자리)다
 * @property {() => boolean} clickTray 트레이 좌클릭(main 이 단 click 처리기 — win32). 처리기가 있었으면 true
 * @property {() => boolean} openViaMain main 의 길로 연다(win32 트레이 클릭 · 그 밖 최신 메뉴의 '열기'). 누를 것이 있었으면 true
 * @property {() => Promise<WindowFact | null>} hideViaMain main 의 길로 숨긴다 — 그 이유의 새 숨김 기록, 아니면 null(던지지 않는다)
 * @property {(records?: readonly WindowFact[]) => string[]} windowTrail 마지막 창 기록 몇 건(action:reason) — 실패 글에 싣는다
 * @property {(notes: string[]) => Promise<boolean>} endShown 창을 main 의 길로 보인 채 둔다(R13) — 다시 보였으면 notes 에 적는다. 보이면 true
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
 * 창 검사 한 벌을 만든다 — 검사마다 판정({ ok, detail })을 돌려주는 함수다. 실행기가 screenshot 바로 뒤에 theme → opacity 차례로 부른다.
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
   * @returns {boolean}
   */
  function stopped(problems, label) {
    const gone = destroyed();
    if (gone === null) return false;
    problems.push(`${label} 전에 ${gone} — 검사를 멈춘다`);
    return true;
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
   * (체크 해제) + settings.json dark. 끝에(실패 길에서도) 창을 main 의 길로 보인 채 둔다.
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
      await ctx.endShown(notes);
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
   * 줄이 남긴 값을 전제로 한다(잘못된 값은 64 에서 보낸다). 끝에(실패 길에서도) 창을 main 의 길로 보인 채 둔다.
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
      await ctx.endShown(notes);
    }
    const saved = OPACITY_TABLE.filter((row) => row.saves).map((row) => row.expect);
    return verdictOf(problems, [
      `${OPACITY_TABLE.map(rowLabel).join(' · ')} — 줄마다 수신 기록 = 보낸 값(NaN 은 "NaN") · 스냅샷 opacity = round(getOpacity() × 100) = 기대값 · 저장값이 바뀐 줄의 settings.json opacity ${saved.join(' → ')}`,
      ...notes,
    ].join(' · '));
  }

  return { theme, opacity };
}

module.exports = { createWindowChecks };
