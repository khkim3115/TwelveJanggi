// 온라인 대전 규칙 일치 검증 — 실제 Supabase 프로젝트에서 서버(tj_* RPC)와 클라이언트(src/core)가 같은 규칙으로
// 두고 판정하는지 확인한다. src/core 나 supabase/schema.sql 의 규칙을 고쳤으면 돌릴 것.
//
//   npm run e2e:mp                    # .env.local 의 VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY 로 실행
//   npm run e2e:mp -- --games 6       # AI 자가대국 판 수(기본 4)
//   npm run e2e:mp -- --timeout       # 시간초과 시나리오까지(120초 기다린다)
//   npm run e2e:mp -- --steps-sql     # tj_can_step 전수(2×5×12×12) 대조 SQL 만 출력 — SQL 편집기에서 돌려 0행이면 일치
//
// 익명 사용자 2명을 모든 시나리오에 다시 쓴다(익명 가입은 IP 당 시간 제한이 있다):
//  ① AI 자가대국 — 매 ply 판·손패·차례·수·직전 수를 대조하고, 끝나면 승패 사유까지
//  ② 입성(try) ③ 시작 국면 포함 3회 반복(8 ply) ④ 王 잡기 ⑤ 승격·侯 잡기 → 子·놓기 3종(이동은 p_piece 생략도 섞는다)
//  ⑥ 거부 — 시작 전 착수·비방장 시작·차례 아님·상대 진영 놓기·빈 손패·점유 칸·상대 말 이동·틀린 p_piece·범위 밖,
//     RLS(비회원 읽기)·직접 쓰기·내부 함수 호출
//  ⑦ 기권
// ⚠️ 실제 DB 에 방을 만든다(끝난 방은 tj_create_room 이 24시간 뒤 정리한다). anon 키로만 돈다 — 서비스 롤 키 금지.

import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CELL_COUNT, KINDS, canStep } from '../src/core/board';
import {
  DROP,
  applyMove,
  applyResign,
  createInitialState,
  legalMoves,
  moveKey,
  type GameState,
  type Move,
  type Player,
} from '../src/core/gameState';
import { mulberry32 } from '../src/core/rng';
import { chooseMove, type Difficulty } from '../src/engine/ai';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/* ── tj_can_step 전수 대조 SQL ────────────────────────────────────────── */

if (flag('steps-sql')) {
  const rows: string[] = [];
  for (const side of [1, 2] as const) {
    for (const kind of KINDS) {
      for (let from = 0; from < CELL_COUNT; from++) {
        for (let to = 0; to < CELL_COUNT; to++) {
          if (canStep(side, kind, from, to)) rows.push(`(${side},${kind},${from},${to})`);
        }
      }
    }
  }
  console.log(`-- board.ts STEPS 의 참인 칸 ${rows.length}개와 tj_can_step 을 2×5×12×12 전부 비교한다. 0행이면 일치.
with expected(s, k, f, t) as (values ${rows.join(',')}),
allc as (select s, k, f, t from generate_series(1,2) s, generate_series(1,5) k,
           generate_series(0,11) f, generate_series(0,11) t)
select 'server-false' as diff, a.* from allc a
  where exists (select 1 from expected e where (e.s, e.k, e.f, e.t) = (a.s, a.k, a.f, a.t))
    and not public.tj_can_step(a.s, a.k, a.f, a.t)
union all
select 'server-true', a.* from allc a
  where not exists (select 1 from expected e where (e.s, e.k, e.f, e.t) = (a.s, a.k, a.f, a.t))
    and public.tj_can_step(a.s, a.k, a.f, a.t);`);
  process.exit(0);
}

/* ── 환경 ─────────────────────────────────────────────────────────────── */

function loadEnv(): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    console.error('.env.local 이 없습니다 — VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY 두 줄을 넣어 주세요.');
    process.exit(1);
  }
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => /^\s*[A-Z_][A-Z0-9_]*\s*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

/** 서비스 롤 키로 돌면 RLS·권한 확인이 전부 의미가 없어진다(그리고 키가 새면 안 된다). */
function assertAnonKey(key: string) {
  if (key.startsWith('sb_secret_')) throw new Error('서비스 키(sb_secret_)로는 돌리지 않습니다 — anon 키를 쓰세요.');
  const part = key.split('.')[1];
  if (!part) return;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { role?: string };
    if (payload.role && payload.role !== 'anon') throw new Error(`anon 키가 아닙니다(role=${payload.role}).`);
  } catch (e) {
    if (e instanceof Error && e.message.includes('anon')) throw e;
  }
}

const env = loadEnv();
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_ANON_KEY;
if (!URL_ || !KEY) {
  console.error('.env.local 에 VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY 가 필요합니다.');
  process.exit(1);
}
assertAnonKey(KEY);

const mk = () =>
  createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const A = mk();
const B = mk();

/* ── 도우미 ───────────────────────────────────────────────────────────── */

let checks = 0;
let failures = 0;
const ok = (msg: string) => {
  checks++;
  console.log('  ✓ ' + msg);
};
const fail = (msg: string) => {
  failures++;
  console.error('  ❌ ' + msg);
};

interface RoomRow {
  id: string;
  code: string;
  status: string;
  green_seat: number | null;
  turn: Player | null;
  board: number[];
  hand: number[];
  move_count: number;
  last_move: { from: number; to: number; piece: number; promote: boolean; captured: number } | null;
  winner_seat: number | null;
  win_reason: string | null;
  is_draw: boolean;
  draw_reason: string | null;
  version: number;
}

async function rpc(c: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await c.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

async function rejects(label: string, c: SupabaseClient, fn: string, args: Record<string, unknown>, needle: string) {
  const { error } = await c.rpc(fn, args);
  if (!error) fail(`${label}: 거부돼야 하는데 통과`);
  else if (!error.message.includes(needle)) fail(`${label}: 예상 '${needle}' / 실제 '${error.message}'`);
  else ok(`거부 — ${label} (${error.message})`);
}

async function readRoom(c: SupabaseClient, id: string): Promise<RoomRow | null> {
  const { data, error } = await c.from('tj_rooms').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error('방 읽기: ' + error.message);
  return data as RoomRow | null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 서버 행과 로컬 국면이 같은가. move 가 있으면 직전 수(잡힌 말 포함)까지. 다르면 false. */
function compare(label: string, r: RoomRow | null, s: GameState, move: Move | null, captured: number): boolean {
  const before = failures;
  if (!r) {
    fail(`${label}: 방을 읽지 못함`);
    return false;
  }
  if (!same(r.board, Array.from(s.board))) fail(`${label}: 판 불일치\n     서버 ${r.board}\n     로컬 ${Array.from(s.board)}`);
  if (!same(r.hand, Array.from(s.hand))) fail(`${label}: 손패 불일치 서버 ${r.hand} / 로컬 ${Array.from(s.hand)}`);
  if (r.turn !== s.turn) fail(`${label}: 차례 불일치 서버 ${r.turn} / 로컬 ${s.turn}`);
  if (r.move_count !== s.ply) fail(`${label}: 수 불일치 서버 ${r.move_count} / 로컬 ${s.ply}`);
  const over = s.phase === 'over';
  if ((r.status === 'finished') !== over) fail(`${label}: 종료 불일치 서버 ${r.status} / 로컬 ${s.phase}`);
  if (over && s.result) {
    if (s.result.kind === 'draw') {
      if (!r.is_draw || r.draw_reason !== s.result.reason) fail(`${label}: 무승부 불일치 서버 ${r.is_draw} ${r.draw_reason}`);
    } else {
      const side = r.winner_seat === r.green_seat ? 1 : 2;
      if (r.is_draw || side !== s.result.winner || r.win_reason !== s.result.reason) {
        fail(`${label}: 승패 불일치 로컬 ${JSON.stringify(s.result)} / 서버 좌석 ${r.winner_seat}(녹 ${r.green_seat}) ${r.win_reason}`);
      }
    }
  }
  if (move) {
    const lm = r.last_move;
    const got = lm && [lm.from, lm.to, lm.piece, lm.promote, lm.captured];
    const want = [move.from, move.to, move.piece, move.promote, captured];
    if (!same(got, want)) fail(`${label}: 직전 수 불일치 서버 ${JSON.stringify(lm)} / 로컬 ${JSON.stringify(want)}`);
  }
  return failures === before;
}

interface Game {
  id: string;
  code: string;
  host: SupabaseClient;
  guest: SupabaseClient;
  bySide: Record<Player, SupabaseClient>;
  local: GameState;
  row: RoomRow;
}

let hostTurn = 0;

/** 방 만들기 → 참가 → 시작. 방장은 번갈아 맡는다(방 만들기 제한이 세션당이라). */
async function newGame(label: string): Promise<Game> {
  const [host, guest] = hostTurn++ % 2 === 0 ? [A, B] : [B, A];
  const created = (await rpc(host, 'tj_create_room', { p_display_name: '앨리스' })) as { room_id: string; code: string };
  await rpc(guest, 'tj_join_room', { p_code: created.code, p_display_name: '밥' });
  await rpc(host, 'tj_start_game', { p_room: created.room_id });
  const row = (await readRoom(host, created.room_id))!;
  const green = row.green_seat === 0 ? host : guest;
  const local = createInitialState();
  compare(`${label} 시작`, row, local, null, 0);
  return { id: created.room_id, code: created.code, host, guest, bySide: { 1: green, 2: green === A ? B : A }, local, row };
}

/** 한 수를 서버에 두고 로컬에도 둔 뒤 대조한다. */
async function play(g: Game, m: Move, label: string, omitPiece = false): Promise<boolean> {
  const captured = m.from === DROP ? 0 : g.local.board[m.to];
  const client = g.bySide[g.local.turn];
  const version = g.row.version;
  await rpc(client, 'tj_play', { p_room: g.id, p_from: m.from, p_to: m.to, p_piece: omitPiece ? null : m.piece });
  g.local = applyMove(g.local, m);
  g.row = (await readRoom(client, g.id))!;
  const good = compare(label, g.row, g.local, m, captured);
  if (g.row.version !== version + 1) fail(`${label}: 한 수에 version 이 ${g.row.version - version} 올랐다(UPDATE 한 번이어야 한다)`);
  return good;
}

function mv(s: GameState, key: string): Move {
  const m = legalMoves(s).find((x) => moveKey(x) === key);
  if (!m) throw new Error(`시나리오 오류 — 합법 수가 아님: ${key}`);
  return m;
}

async function scripted(label: string, keys: string[], want: GameState['result'], omit: Set<number> = new Set()) {
  console.log(`\n${label}`);
  const g = await newGame(label);
  let good = true;
  for (const [i, k] of keys.entries()) good = (await play(g, mv(g.local, k), `${label} #${i + 1} ${k}`, omit.has(i))) && good;
  if (!same(g.local.result, want)) fail(`${label}: 로컬 결과 ${JSON.stringify(g.local.result)} / 기대 ${JSON.stringify(want)}`);
  else if (good) ok(`${keys.length} ply 매 수 일치, 결과 ${want ? JSON.stringify(want) : '진행 중'}`);
  return g;
}

/* ── 시나리오 ─────────────────────────────────────────────────────────── */

async function permissions() {
  console.log('\n⑥ 시작 전 · 권한');
  const created = (await rpc(A, 'tj_create_room', { p_display_name: '앨리스' })) as { room_id: string; code: string };
  hostTurn++;
  const id = created.room_id;
  if ((await readRoom(B, id)) === null) ok('비회원에게는 방이 보이지 않는다(RLS)');
  else fail('비회원이 방을 읽었다');
  const upd = await B.from('tj_rooms').update({ status: 'finished' }).eq('id', id);
  if (upd.error) ok(`직접 UPDATE 거부 (${upd.error.message})`);
  else fail('직접 UPDATE 가 통과했다');
  const ins = await A.from('tj_rooms').insert({ code: 'ZZZZZZ', host_id: '00000000-0000-0000-0000-000000000000' });
  if (ins.error) ok(`직접 INSERT 거부 (${ins.error.message})`);
  else fail('직접 INSERT 가 통과했다');
  const fb = await A.from('tj_feedback').select('*').limit(1);
  if (fb.error) ok(`피드백 읽기 거부 (${fb.error.message})`);
  else fail('피드백 테이블을 읽었다');
  for (const [fn, args] of [
    ['tj_can_step', { p_side: 1, p_kind: 1, p_from: 0, p_to: 1 }],
    ['tj_cleanup_rooms', {}],
  ] as const) {
    const { error } = await A.rpc(fn, args);
    if (error) ok(`내부 함수 ${fn} 호출 거부 (${error.message})`);
    else fail(`내부 함수 ${fn} 가 호출됐다`);
  }
  await rejects('시작 전 착수', A, 'tj_play', { p_room: id, p_from: 7, p_to: 4, p_piece: 4 }, 'not playing');
  await rejects('혼자 시작', A, 'tj_start_game', { p_room: id }, 'need 2 players');
  await rpc(B, 'tj_join_room', { p_code: created.code.toLowerCase(), p_display_name: '밥' });
  await rejects('비방장 시작', B, 'tj_start_game', { p_room: id }, 'only host can start');
  await rpc(A, 'tj_leave_room', { p_room: id });
  await rpc(B, 'tj_leave_room', { p_room: id });
}

/** ⑤ 의 3번째 수 직전(녹 차례, 녹 손패 子 1, 적 相 이 4 에 있음)에서 불법 수를 하나씩 넣어 본다. */
async function rejections(g: Game) {
  const green = g.bySide[1];
  const red = g.bySide[2];
  const v = g.row.version;
  const R = (label: string, c: SupabaseClient, from: number | null, to: number | null, piece: number | null, needle = 'illegal move') =>
    rejects(label, c, 'tj_play', { p_room: g.id, p_from: from, p_to: to, p_piece: piece }, needle);
  await R('상대 진영(행 0)에 놓기', green, DROP, 2, 4);
  await R('손패에 없는 相 놓기', green, DROP, 3, 3);
  await R('점유 칸에 놓기', green, DROP, 4, 4);
  await R('놓기에 p_piece 없음', green, DROP, 3, null);
  // 相 이 갈 수 있는 대각 칸으로 — 소유 확인 말고는 거부할 이유가 없는 수라야 그 확인을 검사한다.
  await R('상대 말 움직이기', green, 4, 8, 3);
  await R('틀린 p_piece(王 을 將 이라고)', green, 10, 7, 2);
  await R('한 걸음 밖', green, 10, 4, 1);
  // 놓기로 — 이동이면 빈 출발 칸·한 걸음 판정이 먼저 막아 범위 확인을 검사하지 못한다.
  await R('범위 밖 칸(놓기)', green, DROP, 12, 4);
  await R('범위 밖 출발', green, -2, 3, 4);
  await R('차례 아닌 쪽', red, 0, 3, 2, 'not your turn');
  const after = (await readRoom(green, g.id))!;
  if (after.version === v && compare('거부 뒤 판', after, g.local, null, 0)) ok('거부된 수는 방을 바꾸지 않는다');
  else fail('거부된 수가 방을 바꿨다');
}

async function selfPlay(i: number, difficulty: Difficulty) {
  const label = `① 자가대국 ${i + 1} (${difficulty})`;
  console.log(`\n${label}`);
  const g = await newGame(label);
  const rng = mulberry32(1000 + i);
  let good = true;
  for (let ply = 0; ply < 200 && g.local.phase !== 'over'; ply++) {
    const m = chooseMove(g.local, difficulty, { rng, timeBudgetMs: 80 });
    if (!m) {
      fail(`${label}: 둘 수가 없다(ply ${ply})`);
      return;
    }
    good = (await play(g, m, `${label} ply ${ply + 1}`, m.from !== DROP && rng() < 0.3)) && good;
    if (!good) break;
  }
  if (g.local.phase !== 'over') {
    await rpc(g.bySide[g.local.turn], 'tj_resign', { p_room: g.id });
    const quitter = g.local.turn;
    g.local = applyResign(g.local, quitter);
    g.row = (await readRoom(g.host, g.id))!;
    good = compare(`${label} 기권`, g.row, g.local, null, 0) && good;
  }
  if (good) ok(`${g.local.ply} ply 매 수 일치, 결과 ${JSON.stringify(g.local.result)}`);
  await leaveBoth(g);
}

async function leaveBoth(g: Game) {
  await rpc(g.host, 'tj_leave_room', { p_room: g.id });
  await rpc(g.guest, 'tj_leave_room', { p_room: g.id });
}

async function timeoutScenario() {
  const label = '시간초과(120초)';
  console.log(`\n${label}`);
  const g = await newGame(label);
  await rejects('내 차례에 시간초과 주장', g.bySide[1], 'tj_claim_timeout', { p_room: g.id }, 'your turn');
  await rejects('이른 시간초과 주장', g.bySide[2], 'tj_claim_timeout', { p_room: g.id }, 'not timed out yet');
  console.log('  … 121초 기다림');
  await new Promise((r) => setTimeout(r, 121_000));
  await rpc(g.bySide[2], 'tj_claim_timeout', { p_room: g.id });
  const r = (await readRoom(g.host, g.id))!;
  const winnerSide = r.winner_seat === r.green_seat ? 1 : 2;
  if (r.status === 'finished' && r.win_reason === 'timeout' && winnerSide === 2) ok('기다린 적이 시간초과로 이겼다');
  else fail(`시간초과 결과 ${r.status} ${r.win_reason} 승자 진영 ${winnerSide}`);
  await leaveBoth(g);
}

/* ── 실행 ─────────────────────────────────────────────────────────────── */

async function main() {
  const t0 = Date.now();
  const a = await A.auth.signInAnonymously();
  const b = await B.auth.signInAnonymously();
  if (a.error || b.error) throw new Error('익명 로그인 실패: ' + (a.error ?? b.error)!.message);
  console.log(`익명 세션 2개: ${a.data.user!.id.slice(0, 8)} · ${b.data.user!.id.slice(0, 8)}`);

  await permissions();

  const try_ = await scripted('② 입성(try)', ['10-8', '0-3', '8-5', '3-0', '5-2', '0-3'], { kind: 'win', winner: 1, reason: 'try' });
  await leaveBoth(try_);
  const rep = await scripted(
    '③ 3회 반복 — 시작 국면 포함, 8 ply 에서 무승부',
    ['11-8', '0-3', '8-11', '3-0', '11-8', '0-3', '8-11', '3-0'],
    { kind: 'draw', reason: 'repetition' },
  );
  await leaveBoth(rep);
  const cap = await scripted('④ 王 잡기', ['7-4', '1-4', '10-7', '4-7'], { kind: 'win', winner: 2, reason: 'capture' });
  await leaveBoth(cap);

  // ⑤ 승격 · 侯 잡기 → 子 · 놓기 3종 — 두 수를 둔 뒤 ⑥ 거부를 넣고 이어 둔다. 몇 수는 p_piece 를 생략한다.
  console.log('\n⑤ 승격 · 侯 잡기 → 子 · 놓기 3종 (+ ⑥ 거부, ⑦ 기권)');
  const keys = ['7-4', '2-4', 'P*5', 'P*6', '5-2+', '1-2', '10-6', '0-3', '6-3', 'P*7', 'R*5', '2-5', '9-7', '5-7', '3-4', 'B*6', 'B*3'];
  const omit = new Set([6, 8, 13]);
  const g = await newGame('⑤');
  let good = true;
  for (const [i, k] of keys.entries()) {
    if (i === 2) await rejections(g);
    good = (await play(g, mv(g.local, k), `⑤ #${i + 1} ${k}`, omit.has(i))) && good;
  }
  if (good) ok(`${keys.length} ply 매 수 일치 — 승격 1·侯 잡기 1·놓기 子 3·將 1·相 2, p_piece 생략 ${omit.size}수`);
  // ⑦ 기권: 지금 차례(적)가 기권하면 녹이 이긴다.
  await rpc(g.bySide[g.local.turn], 'tj_resign', { p_room: g.id });
  g.local = applyResign(g.local, g.local.turn);
  g.row = (await readRoom(g.host, g.id))!;
  if (compare('⑦ 기권', g.row, g.local, null, 0)) ok(`⑦ 기권 — ${JSON.stringify(g.local.result)}`);
  await rejects('끝난 방에 착수', g.bySide[1], 'tj_play', { p_room: g.id, p_from: 4, p_to: 1, p_piece: 1 }, 'not playing');
  await leaveBoth(g);

  const games = Number(opt('games', '4'));
  const levels: Difficulty[] = ['normal', 'easy', 'hard', 'normal'];
  for (let i = 0; i < games; i++) await selfPlay(i, levels[i % levels.length]);

  if (flag('timeout')) await timeoutScenario();

  console.log(`\n${failures === 0 ? '✅' : '❌'} 확인 ${checks}개 · 실패 ${failures}개 (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
  if (failures === 0) console.log('서버와 클라이언트의 규칙·판정·권한이 일치한다.');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('❌ ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
