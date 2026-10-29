'use strict';
// 스모크 결과 파일(설계 §5.10) — main 의 실패 단계(lock · tray-build)와 스모크 실행기가 같은 함수로 쓴다. 런처는 결과의 nonce 로
// 이번 실행의 것인지 가린다(지난 실행의 결과가 섞이지 않게). 런처의 summary.json 도 같은 쓰기(writeJsonAtomic)를 쓴다 — 쓰는 방식이
// 따로 놀지 않게. electron 을 require 하지 않는다.
// 쓰기는 원자적이다: 같은 폴더의 임시 파일에 다 쓴 뒤 rename 한다 — 런처가 반쯤 쓴 파일을 읽지 않는다. 실패하면 임시 파일을
// 지우고 던진다(남는 것은 그 파일 하나뿐이다).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** 결과 파일 이름 — 런처는 <outDir>/result.json 을 읽는다. */
const RESULT_FILE = 'result.json';

/**
 * 스모크 결과의 versions — 결과 파일마다 이 모양이다(계획 Task 8 의 SmokeResult.versions). 실패 단계의 결과도 같다.
 * IPC tj-app-info 의 응답(AppInfo { version, electron, chrome, platform })과는 다른 계약이다.
 * @typedef {object} SmokeVersions
 * @property {string} electron process.versions.electron
 * @property {string} chrome process.versions.chrome
 * @property {string} node process.versions.node
 * @property {string} app 앱 버전(app.getVersion())
 */
/**
 * 실패 단계의 결과 — 검사는 하나도 돌지 않았다(checks 는 빈 목록). 런처의 판정은 exit 1 과 필수 검사 없음으로 실패한다.
 * @typedef {object} FailureResult
 * @property {string} nonce 런처가 준 이번 실행의 표식
 * @property {string} stage 실패한 단계('lock' · 'tray-build')
 * @property {string} error 이유 한 줄
 * @property {unknown[]} checks 빈 목록
 * @property {SmokeVersions} versions 버전
 */

/**
 * value 를 <dir>/<name> 에 JSON 으로 원자적으로 쓴다(임시 파일 → rename). dir 이 없으면 만든다. 실패하면 임시 파일을 지우고 던진다.
 * @param {string} dir 절대 경로
 * @param {string} name 파일 이름(dir 바로 아래)
 * @param {unknown} value JSON 으로 쓸 값
 * @returns {void}
 */
function writeJsonAtomic(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  // 같은 폴더에 둔다 — rename 은 같은 볼륨 안에서만 원자적이다. 이름이 겹치지 않게 pid · 무작위 꼬리를 붙인다.
  const temp = path.join(dir, `.${name}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temp, target);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // 임시 파일을 못 지워도 원래 오류를 낸다 — 그쪽이 원인이다
    }
    throw err;
  }
}

/**
 * obj 를 <outDir>/result.json 에 원자적으로 쓴다(writeJsonAtomic). outDir 이 없으면 만든다. 실패하면 임시 파일을 지우고 던진다.
 * @param {string} outDir 절대 경로
 * @param {object} obj JSON 으로 쓸 값
 * @returns {void}
 */
function writeResultAtomic(outDir, obj) {
  writeJsonAtomic(outDir, RESULT_FILE, obj);
}

/**
 * 실패 단계의 결과 객체.
 * @param {{ nonce: string, stage: string, error: string, versions: SmokeVersions }} input
 * @returns {FailureResult}
 */
function failureResult({ nonce, stage, error, versions }) {
  return { nonce, stage, error, checks: [], versions };
}

module.exports = { RESULT_FILE, writeJsonAtomic, writeResultAtomic, failureResult };
