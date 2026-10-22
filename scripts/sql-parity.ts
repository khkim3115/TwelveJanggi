// 서버(plpgsql)·클라이언트 규칙 일치를 로컬 Postgres(PGlite — WASM)로 검증한다. 실서버 e2e(npm run e2e:mp)와 달리
// DB·비밀값 없이 돌아서 PR 마다 CI 가 빠른 모드를 돌린다. supabase/schema.sql 을 Supabase 와 비슷한 환경
// (anon·authenticated 롤 · auth.uid() · 기본 ACL · pgcrypto)에 올리고 src/core 와 규칙·판정·권한을 대조한다.
// 공유 DB 에 SQL 을 적용하기 전에도 돌린다(--sql 로 초안 파일을 줄 수 있다).
//
//   npm run test:sql                         # 빠른 모드 — 4판 · 표본 국면 5%(약 20초). CI 가 PR 마다 돌린다
//   npm run test:sql -- --deep               # 깊은 모드 — 60판 · 표본 8%. src/core 나 supabase/ 규칙을 고쳤을 때
//   npm run test:sql -- --games 10 --sample 0.1 --seed 2   # 직접 지정(--deep 값 위에 덮어쓴다)
//   npm run test:sql -- --sql <파일>         # 다른 SQL 로(기본 supabase/schema.sql)
//
// ① 권한 매트릭스 · 공개 RPC 시그니처 ② tj_can_step 전수 = STEPS ③ 판정 순서 9가지(gameState.test.ts 이식)
// ④ 시작 국면 시나리오 ⑤ 무작위 대국 매 ply + 표본 국면마다 가능한 모든 tj_play 인자(받는 수 = legalMoves,
// 결과 = applyMove) ⑥ tj_has_move = hasLegalMove · tj_pos_key ↔ computeKey ⑦ 방 흐름 · 오류 문구 · 시간초과 ·
// 나가기 · 정리 · 제한 · 1000 ply 상한 · CHECK ⑧ 피드백
//
// ⚠️ PGlite 0.5.8 은 SQL 오류 1건마다 스택이 조금씩 새서, 한 인스턴스에서 약 1,870건 뒤에는 모든 문장이
// 'stack depth limit exceeded' 로 실패한다(savepoint 로도 못 막는다). 그래서 오류를 많이 내는 ⑤ 의 전수 대조는
// 국면마다 새 인스턴스에서 돌린다.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { canStep, type Kind } from '../src/core/board';
import {
  DROP,
  applyMove,
  createInitialState,
  fromTransfer,
  hasLegalMove,
  legalMoves,
  moveKey,
  other,
  stateFrom,
  toTransfer,
  type GameResult,
  type GameState,
  type Move,
  type Player,
} from '../src/core/gameState';
import { mulberry32 } from '../src/core/rng';
import { formatBoard, formatHand, makeState, type StateSpec } from '../src/core/testkit';
import { chooseMove } from '../src/engine/ai';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DEEP = flag('deep');
const sqlArg = opt('sql', '');
const SQL_PATH = sqlArg ? resolve(sqlArg) : fileURLToPath(new URL('../supabase/schema.sql', import.meta.url));
const GAMES = Number(opt('games', DEEP ? '60' : '4'));
const SAMPLE = Number(opt('sample', DEEP ? '0.08' : '0.05'));
const SEED = Number(opt('seed', '1'));
if (!Number.isInteger(GAMES) || GAMES < 0 || !(SAMPLE >= 0 && SAMPLE <= 1) || !Number.isInteger(SEED)) {
  console.error('--games 는 0 이상 정수, --sample 은 0–1, --seed 는 정수여야 합니다.');
  process.exit(2);
}

let failures = 0;
const ok = (msg: string) => console.log('✓ ' + msg);
const fail = (msg: string) => {
  failures++;
  console.error('❌ ' + msg);
  if (failures > 40) {
    console.error('실패가 너무 많아 중단');
    process.exit(1);
  }
};
const t0 = Date.now();
console.log(`${DEEP ? '깊은' : '빠른'} 모드 — ${GAMES}판 · 표본 ${SAMPLE} · 시드 ${SEED} · ${SQL_PATH}`);

/* ── 환경 ─────────────────────────────────────────────────────────────── */

const schemaSql = readFileSync(SQL_PATH, 'utf8');

/** Supabase 흉내를 낸 빈 DB 에 schema.sql 을 올린다. */
async function makeDb(): Promise<PGlite> {
  const pg = await PGlite.create({ extensions: { pgcrypto } });
  await pg.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create schema extensions;
    grant usage on schema extensions to anon, authenticated, service_role;
    create extension pgcrypto schema extensions;
    create schema auth;
    grant usage on schema auth to anon, authenticated, service_role;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    -- Supabase(이 프로젝트)의 기본 ACL: postgres 가 public 에 만드는 객체에 anon·authenticated 전 권한.
    -- schema.sql 이 tj_ 객체를 하나씩 회수하지 않으면 ① 권한 매트릭스에서 걸린다.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    create publication supabase_realtime;
  `);
  await pg.exec(schemaSql);
  return pg;
}

let db = await makeDb();
const who = (await db.query<{ u: string; v: string }>('select current_user as u, version() as v')).rows[0];
console.log('PGlite:', who.u, '|', who.v.split(',')[0]);
ok('schema.sql 적용');
try {
  await db.exec(schemaSql);
  ok('schema.sql 재적용(멱등)');
} catch (e) {
  fail('schema.sql 재적용 실패: ' + (e as Error).message);
}

/* ── 도우미 ───────────────────────────────────────────────────────────── */

type Role = 'anon' | 'authenticated';
/** 서비스 롤(postgres)로 읽는 임의 행. */
type Row = Record<string, any>;

interface RoomRow {
  id: string;
  code: string;
  status: string;
  host_id: string;
  green_seat: number | null;
  turn: number | null;
  board: number[];
  hand: number[];
  move_count: number;
  last_move: { from: number; to: number; piece: number; promote: boolean; captured: number } | null;
  winner_seat: number | null;
  win_reason: string | null;
  is_draw: boolean;
  draw_reason: string | null;
  version: number;
  /** 반복 횟수 표(tj_room_positions — 클라이언트 롤에는 막혀 있어 서비스 롤로 따로 읽는다). */
  pos_counts: Record<string, number>;
}

/** tj_create_room · tj_join_room 의 반환. */
interface Entered {
  room_id: string;
  code: string;
  seat: number;
  server_now: string;
}

const uid = () => randomUUID();

async function su<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function asUser<T>(u: string | null, role: Role, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [u ?? '']);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}

/** 클라이언트처럼 이름 붙인 인자로 RPC 를 부른다(u = 세션 사용자, null 이면 세션 없음). */
async function rpc<T = unknown>(u: string | null, fn: string, args: Record<string, unknown>, role: Role = 'authenticated'): Promise<T> {
  const names = Object.keys(args);
  const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  return asUser(u, role, async () => (await db.query<{ r: T }>(sql, names.map((n) => args[n]))).rows[0]?.r as T);
}

async function rpcErr(u: string | null, fn: string, args: Record<string, unknown>, role: Role = 'authenticated') {
  try {
    await rpc(u, fn, args, role);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

async function expectErr(ctx: string, u: string | null, fn: string, args: Record<string, unknown>, needle: string, role: Role = 'authenticated') {
  const e = await rpcErr(u, fn, args, role);
  if (e === null) fail(`${ctx}: 거부돼야 하는데 통과`);
  else if (!e.includes(needle)) fail(`${ctx}: 예상 '${needle}' / 실제 '${e}'`);
}

async function positions(id: string): Promise<Record<string, number>> {
  const rows = await su<{ pos_key: string; cnt: number }>('select pos_key, cnt from public.tj_room_positions where room_id = $1', [id]);
  return Object.fromEntries(rows.map((r) => [r.pos_key, r.cnt]));
}

/** 회원 u 가 보는 방 행(RLS — 비회원이면 undefined) + 반복 횟수 표. */
async function room(u: string, id: string): Promise<RoomRow | undefined> {
  const row = await asUser(u, 'authenticated', async () => (await db.query<RoomRow>('select * from public.tj_rooms where id = $1', [id])).rows[0]);
  if (row) row.pos_counts = await positions(id);
  return row;
}

async function setPositions(id: string, counts: Record<string, number>) {
  await su('delete from public.tj_room_positions where room_id = $1', [id]);
  for (const [k, n] of Object.entries(counts)) {
    await su('insert into public.tj_room_positions(room_id, pos_key, cnt) values ($1, $2, $3)', [id, k, n]);
  }
}

interface Game {
  id: string;
  code: string;
  host: string;
  guest: string;
  uidOf: Record<Player, string>;
}

/** 방 만들기 → 참가 → 시작. 녹(선공) 좌석은 서버가 무작위로 정한다. */
async function newGame(): Promise<Game> {
  const host = uid();
  const guest = uid();
  const c = await rpc<Entered>(host, 'tj_create_room', { p_display_name: '녹녹' });
  await rpc(guest, 'tj_join_room', { p_code: c.code, p_display_name: '적적' });
  await rpc(host, 'tj_start_game', { p_room: c.room_id });
  const r = await room(host, c.room_id);
  const green = r?.green_seat === 0 ? host : guest;
  return { id: c.room_id, code: c.code, host, guest, uidOf: { 1: green, 2: green === host ? guest : host } };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** tj_pos_key 와 같은 모양의 국면 키. */
const serverKey = (s: Pick<GameState, 'board' | 'hand' | 'turn'>) => `${Array.from(s.board).join(',')}|${Array.from(s.hand).join(',')}|${s.turn}`;

/** 서버 행과 로컬 국면을 대조한다. lastMove 가 있으면 직전 수(잡힌 말 포함)까지, 반복 횟수 표까지. */
function compare(ctx: string, r: RoomRow | null | undefined, s: GameState, lastMove: Move | null, captured: number) {
  if (!r) return fail(`${ctx}: 방을 읽지 못함`);
  if (!same(r.board, Array.from(s.board))) fail(`${ctx}: 판 불일치\n  서버 ${r.board}\n  로컬 ${Array.from(s.board)}`);
  if (!same(r.hand, Array.from(s.hand))) fail(`${ctx}: 손패 불일치 서버 ${r.hand} / 로컬 ${Array.from(s.hand)}`);
  if (r.turn !== s.turn) fail(`${ctx}: 차례 불일치 서버 ${r.turn} / 로컬 ${s.turn}`);
  if (r.move_count !== s.ply) fail(`${ctx}: 수 불일치 서버 ${r.move_count} / 로컬 ${s.ply}`);
  const over = s.phase === 'over';
  if ((r.status === 'finished') !== over) fail(`${ctx}: 종료 불일치 서버 ${r.status} / 로컬 ${s.phase}`);
  if (s.result) {
    if (s.result.kind === 'draw') {
      if (!r.is_draw || r.draw_reason !== s.result.reason) fail(`${ctx}: 무승부 불일치 ${JSON.stringify(s.result)} / ${r.is_draw} ${r.draw_reason}`);
    } else {
      const side = r.winner_seat === r.green_seat ? 1 : 2;
      if (r.is_draw || side !== s.result.winner || r.win_reason !== s.result.reason) {
        fail(`${ctx}: 승패 불일치 로컬 ${JSON.stringify(s.result)} / 서버 승자좌석 ${r.winner_seat}(녹=${r.green_seat}) ${r.win_reason}`);
      }
    }
  } else if (r.is_draw || r.winner_seat !== null || r.win_reason !== null || r.draw_reason !== null) {
    fail(`${ctx}: 진행 중인데 결과 필드가 채워짐`);
  }
  if (lastMove) {
    const lm = r.last_move;
    const got = lm && [lm.from, lm.to, lm.piece, lm.promote, lm.captured];
    const want = [lastMove.from, lastMove.to, lastMove.piece, lastMove.promote, captured];
    if (!same(got, want)) fail(`${ctx}: 직전 수 불일치 서버 ${JSON.stringify(lm)} / 로컬 ${JSON.stringify(want)}`);
  }
  // 반복 횟수: 진행 중이면 지금 국면의 서버 카운트 = 로컬 reps, 끝났으면 서버가 지웠어야 한다
  if (r.status === 'finished') {
    if (Object.keys(r.pos_counts).length !== 0) fail(`${ctx}: 끝난 판에 반복 횟수 행이 남음`);
  } else {
    const cnt = r.pos_counts[serverKey(s)] ?? 0;
    const local = s.reps.get(s.key) ?? 0;
    if (cnt !== local) fail(`${ctx}: 반복 횟수 불일치 서버 ${cnt} / 로컬 ${local}`);
  }
}

const stats: Record<string, number> = {};
const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);

/* ── 1. 권한 매트릭스 · 공개 RPC 시그니처 ─────────────────────────────── */

/**
 * 클라이언트가 부르는 RPC. 이름 · 인자 · 반환은 옛 클라이언트(배포 전에 열어 둔 탭 · 설치한 PWA)와의 공개 계약이다.
 * 인자는 기본값을 붙여 뒤에만 더할 수 있다 — 그런 변경은 이 표를 고치지 않아도 통과하고, 깨는 변경은 여기서 걸린다.
 */
const PUBLIC_RPCS: Record<string, { args: string; returns: string }> = {
  tj_create_room: { args: 'p_display_name text', returns: 'jsonb' },
  tj_join_room: { args: 'p_code text, p_display_name text', returns: 'jsonb' },
  tj_start_game: { args: 'p_room uuid', returns: 'void' },
  tj_play: { args: 'p_room uuid, p_from integer, p_to integer, p_piece integer', returns: 'void' },
  tj_resign: { args: 'p_room uuid', returns: 'void' },
  tj_claim_timeout: { args: 'p_room uuid', returns: 'void' },
  tj_leave_room: { args: 'p_room uuid', returns: 'void' },
  tj_submit_feedback: { args: 'p_kind text, p_message text, p_contact text, p_meta jsonb, p_hp text', returns: 'void' },
};

{
  // tj_is_room_member 는 클라이언트가 부르지 않지만 RLS select 정책·Realtime 인가가 authenticated 로 호출한다.
  const AUTH_FNS = new Set([...Object.keys(PUBLIC_RPCS), 'tj_is_room_member']);
  const ANON_FNS = new Set(['tj_submit_feedback']);
  const fns = await su<{ name: string; args: string; returns: string; nargs: number; ndefaults: number; definer: boolean; anon: boolean; auth: boolean; pub: boolean; cfg: string }>(`
    select p.proname as name, pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as returns,
      p.pronargs as nargs, p.pronargdefaults as ndefaults, p.prosecdef as definer,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
      exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub,
      coalesce(array_to_string(p.proconfig, ';'), '') as cfg
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'tj%' order by 1`);
  console.log(`tj_ 함수 ${fns.length}개`);
  for (const f of fns) {
    if (f.pub) fail(`PUBLIC 이 ${f.name} 실행 가능`);
    if (f.auth !== AUTH_FNS.has(f.name)) fail(`authenticated 실행권 ${f.name}: ${f.auth}`);
    if (f.anon !== ANON_FNS.has(f.name)) fail(`anon 실행권 ${f.name}: ${f.anon}`);
    if (!f.cfg.startsWith('search_path=public')) fail(`${f.name} search_path 없음: ${f.cfg}`);
  }
  console.log('  SECURITY DEFINER:', fns.filter((f) => f.definer).map((f) => f.name).sort().join(', '));
  const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
  for (const t of ['tj_rooms', 'tj_room_players', 'tj_room_positions', 'tj_feedback']) {
    for (const role of ['anon', 'authenticated', 'public']) {
      for (const p of PRIVS) {
        let has: boolean;
        try {
          has =
            role === 'public'
              ? (await su(`select exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                    where c.oid = 'public.${t}'::regclass and a.grantee = 0 and a.privilege_type = $1) as h`, [p]))[0].h
              : (await su(`select has_table_privilege($1, 'public.${t}', $2) as h`, [role, p]))[0].h;
        } catch {
          continue; // MAINTAIN 이 없는 버전
        }
        const want = role === 'authenticated' && p === 'SELECT' && (t === 'tj_rooms' || t === 'tj_room_players');
        if (has !== want) fail(`${role} ${p} on ${t}: ${has}`);
      }
    }
  }
  const rls = await su<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname like 'tj_%' and relkind = 'r' order by 1`);
  for (const r of rls) if (!r.relrowsecurity) fail(`RLS 꺼짐: ${r.relname}`);
  ok('권한 매트릭스 확인');

  for (const [name, want] of Object.entries(PUBLIC_RPCS)) {
    const found = fns.filter((f) => f.name === name);
    if (found.length !== 1) {
      fail(`공개 RPC ${name}: ${found.length === 0 ? '없음' : `오버로드 ${found.length}개(이름 붙인 호출이 모호해진다)`}`);
      continue;
    }
    const f = found[0];
    const extra = f.nargs - want.args.split(', ').length;
    const prefixOk = f.args === want.args || f.args.startsWith(want.args + ', ');
    if (!prefixOk || extra > f.ndefaults || f.returns !== want.returns) {
      fail(`공개 RPC ${name} 시그니처가 바뀜 — 서버 (${f.args}) → ${f.returns} / 계약 (${want.args}) → ${want.returns}.
  옛 클라이언트가 부르는 이름 · 인자 · 반환은 그대로 두고, 인자는 기본값을 붙여 뒤에만 더한다.`);
    }
  }
  ok(`공개 RPC ${Object.keys(PUBLIC_RPCS).length}개 시그니처 호환`);

  // 행동으로도 확인
  const u = uid();
  await expectErr('anon 이 방 만들기', u, 'tj_create_room', { p_display_name: 'x' }, 'permission denied', 'anon');
  await expectErr('authenticated 가 tj_can_step', u, 'tj_can_step', { p_side: 1, p_kind: 1, p_from: 0, p_to: 1 }, 'permission denied');
  await expectErr('authenticated 가 tj_cleanup_rooms', u, 'tj_cleanup_rooms', {}, 'permission denied');
  for (const stmt of [
    `insert into public.tj_rooms(code, host_id) values ('ZZZZZZ', '${u}')`,
    `update public.tj_rooms set status = 'finished'`,
    `delete from public.tj_rooms`,
    `truncate public.tj_rooms`,
    `select * from public.tj_feedback`,
    `insert into public.tj_room_players(room_id, user_id, seat, display_name) values ('${u}', '${u}', 0, 'x')`,
  ]) {
    for (const role of ['anon', 'authenticated'] as const) {
      try {
        await asUser(u, role, () => db.query(stmt));
        fail(`${role} 직접 실행 통과: ${stmt}`);
      } catch (e) {
        if (!(e as Error).message.includes('permission denied')) fail(`${role} '${stmt}': ${(e as Error).message}`);
      }
    }
  }
  ok('직접 쓰기·피드백 읽기 거부');
}

/* ── 2. tj_can_step 전수(2×5×12×12) ───────────────────────────────────── */
{
  const rows = await su<{ s: number; k: number; f: number; t: number; c: boolean }>(`select s, k, f, t, public.tj_can_step(s, k, f, t) as c
    from generate_series(1,2) s, generate_series(1,5) k, generate_series(0,11) f, generate_series(0,11) t`);
  for (const r of rows) {
    const want = canStep(r.s as Player, r.k as Kind, r.f, r.t);
    if (r.c !== want) fail(`tj_can_step(${r.s},${r.k},${r.f},${r.t}) 서버 ${r.c} / STEPS ${want}`);
  }
  const edge = await su(`select public.tj_can_step(3,1,0,1) a, public.tj_can_step(1,6,0,1) b, public.tj_can_step(1,1,-1,0) c,
    public.tj_can_step(1,1,11,12) d, public.tj_can_step(null,1,0,1) e, public.tj_can_step(1,1,2,3) f`);
  if (Object.values(edge[0]).some((v) => v !== false)) fail('tj_can_step 범위 밖 입력이 true: ' + JSON.stringify(edge[0]));
  ok(`tj_can_step ${rows.length}가지 = STEPS`);
}

/* ── 3. 판정 순서(gameState.test.ts 이식) ─────────────────────────────── */

/** 임의 국면을 방에 주입한다(서비스 롤). 반복 이력은 이 국면 1회만 — 이력이 필요한 겹침은 아래 seeded 로 따로. */
async function inject(g: Game, s: GameState) {
  await su(`update public.tj_rooms set board = $1, hand = $2, turn = $3, move_count = 0, last_move = null where id = $4`, [
    Array.from(s.board), Array.from(s.hand), s.turn, g.id,
  ]);
  await setPositions(g.id, { [serverKey(s)]: 1 });
}

function mv(s: GameState, key: string): Move {
  const m = legalMoves(s).find((x) => moveKey(x) === key);
  if (!m) throw new Error(`합법 수가 아님: ${key} @ ${formatBoard(s)}`);
  return m;
}

/** 국면에서 수를 차례로 두며 매 ply 서버와 대조한다. */
async function playBoth(ctx: string, g: Game, s0: GameState, keys: string[]): Promise<GameState> {
  let s = s0;
  for (const [i, k] of keys.entries()) {
    const m = mv(s, k);
    const captured = m.from === DROP ? 0 : s.board[m.to];
    await rpc(g.uidOf[s.turn], 'tj_play', { p_room: g.id, p_from: m.from, p_to: m.to, p_piece: m.piece });
    s = applyMove(s, m);
    compare(`${ctx} #${i + 1} ${k}`, await room(g.host, g.id), s, m, captured);
  }
  return s;
}

{
  const cases: { name: string; spec: StateSpec; keys: string[]; want: GameResult | null }[] = [
    { name: 'try', spec: { board: '... .K. ..k ...', hand: ['RBP', 'RBP'] }, keys: ['4-1', 'R*6'], want: { kind: 'win', winner: 1, reason: 'try' } },
    { name: '입성 王 을 잡음', spec: { board: '..k .K. ... ...', hand: ['RBP', 'RBP'] }, keys: ['4-1', '2-1'], want: { kind: 'win', winner: 2, reason: 'capture' } },
    { name: '양쪽 입성', spec: { board: '... .K. .k. ...', hand: ['RBP', 'RBP'] }, keys: ['4-0', '7-10'], want: { kind: 'win', winner: 1, reason: 'try' } },
    { name: '잡으며 입성', spec: { board: '.k. .K. ... ...', hand: ['RBP', 'RBP'] }, keys: ['4-1'], want: { kind: 'win', winner: 1, reason: 'capture' } },
    { name: 'blocked', spec: { board: 'RB. KRB PPk ...', turn: 2 }, keys: ['8-10'], want: { kind: 'win', winner: 2, reason: 'blocked' } },
    { name: '잡는 수만 남음', spec: { board: 'kR. B.. .P. .K.', hand: ['RBP', ''] }, keys: ['7-4'], want: null },
    { name: 'try > blocked', spec: { board: 'KRB RP. P.k ..B', turn: 2 }, keys: ['8-11'], want: { kind: 'win', winner: 1, reason: 'try' } },
  ];
  for (const c of cases) {
    const g = await newGame();
    const s0 = makeState(c.spec);
    await inject(g, s0);
    const s = await playBoth(`판정 ${c.name}`, g, s0, c.keys);
    if (!same(s.result, c.want)) fail(`판정 ${c.name}: 로컬 결과가 테스트 기대와 다름 ${JSON.stringify(s.result)}`);
  }

  // 이력을 주입한 겹침: try > 반복, 반복 > blocked. 서버 반복 표에 "다음 국면 2회 + 현재 1회" 를 심는다.
  const seeded = async (name: string, spec: StateSpec, key: string, want: GameResult) => {
    const g = await newGame();
    const s0 = makeState(spec);
    const m = mv(s0, key);
    const after = applyMove(s0, m);
    await su(`update public.tj_rooms set board = $1, hand = $2, turn = $3 where id = $4`, [
      Array.from(s0.board), Array.from(s0.hand), s0.turn, g.id,
    ]);
    await setPositions(g.id, { [serverKey(after)]: 2, [serverKey(s0)]: 1 });
    const local = applyMove(fromTransfer({ ...toTransfer(s0), history: [after.key, after.key, s0.key] }), m);
    await rpc(g.uidOf[s0.turn], 'tj_play', { p_room: g.id, p_from: m.from, p_to: m.to, p_piece: m.piece });
    const r = await room(g.host, g.id);
    if (!same(local.result, want)) fail(`${name}: 로컬 기대와 다름 ${JSON.stringify(local.result)}`);
    if (!r) return fail(`${name}: 방을 읽지 못함`);
    const side = r.winner_seat === r.green_seat ? 1 : 2;
    const got = r.is_draw ? { kind: 'draw', reason: r.draw_reason } : { kind: 'win', winner: side, reason: r.win_reason };
    if (!same(got, want)) fail(`${name}: 서버 ${JSON.stringify(got)} / 기대 ${JSON.stringify(want)}`);
    if (Object.keys(r.pos_counts).length !== 0) fail(`${name}: 끝난 판에 반복 횟수 행이 남음`);
  };
  await seeded('try > 반복', { board: 'K.. .k. ... ...', turn: 2, hand: ['RBP', 'RBP'] }, 'R*8', { kind: 'win', winner: 1, reason: 'try' });
  await seeded('반복 > blocked', { board: 'RB. KRB PPk ...', turn: 2 }, '8-10', { kind: 'draw', reason: 'repetition' });
  ok('판정 순서 9가지(이식) 서버 = 로컬');
}

/* ── 4. 시작 국면부터의 시나리오(실서버 e2e 와 같은 수순) ───────────────── */
{
  const SCENARIOS: { name: string; keys: string[]; want: GameResult | null; plies: number }[] = [
    { name: '3회 반복(시작 국면 포함, 8 ply)', keys: ['11-8', '0-3', '8-11', '3-0', '11-8', '0-3', '8-11', '3-0'], want: { kind: 'draw', reason: 'repetition' }, plies: 8 },
    { name: '王 잡기', keys: ['7-4', '1-4', '10-7', '4-7'], want: { kind: 'win', winner: 2, reason: 'capture' }, plies: 4 },
    { name: '입성(try)', keys: ['10-8', '0-3', '8-5', '3-0', '5-2', '0-3'], want: { kind: 'win', winner: 1, reason: 'try' }, plies: 6 },
    {
      name: '승격·侯 잡기·놓기 3종',
      keys: ['7-4', '2-4', 'P*5', 'P*6', '5-2+', '1-2', '10-6', '0-3', '6-3', 'P*7', 'R*5', '2-5', '9-7', '5-7', '3-4', 'B*6', 'B*3'],
      want: null,
      plies: 17,
    },
  ];
  for (const sc of SCENARIOS) {
    const g = await newGame();
    const r0 = await room(g.host, g.id);
    const s0 = createInitialState();
    compare(`${sc.name} 시작`, r0, s0, null, 0);
    if (!same(r0?.pos_counts, { [serverKey(s0)]: 1 })) fail(`${sc.name}: 시작 반복 횟수가 시작 국면 1회가 아님 ${JSON.stringify(r0?.pos_counts)}`);
    const s = await playBoth(sc.name, g, s0, sc.keys);
    if (!same(s.result, sc.want) || s.ply !== sc.plies) fail(`${sc.name}: 로컬 ${JSON.stringify(s.result)} @${s.ply}`);
  }
  ok(`시나리오 ${SCENARIOS.length}가지 서버 = 로컬`);
}

/* ── 5. 무작위 대국 + 표본 국면 전수 수 대조 ───────────────────────────── */

/** tj_play 의 p_piece 후보 — 생략(null)과 종류 1–5. */
const PIECE_OPTIONS = [null, 1, 2, 3, 4, 5];
let exhaustivePositions = 0;
let exhaustiveCalls = 0;
const hasMoveSamples: { board: number[]; hand: number[] }[] = [];

/** 지금 국면을 새 인스턴스로 옮겨 가능한 모든 tj_play 인자를 넣어 본다 — 서버가 받는 수 = legalMoves, 결과 = applyMove. */
async function exhaustive(ctx: string, gMain: Game, s: GameState) {
  exhaustivePositions++;
  const src = (await su('select board, hand, turn, move_count from public.tj_rooms where id = $1', [gMain.id]))[0];
  const srcCounts = await positions(gMain.id);
  const mainDb = db;
  db = await makeDb();
  try {
    const g = await newGame();
    await su('update public.tj_rooms set board = $1, hand = $2, turn = $3, move_count = $4 where id = $5', [
      src.board, src.hand, src.turn, src.move_count, g.id,
    ]);
    await setPositions(g.id, srcCounts);
    await exhaustiveIn(ctx, g, s);
  } finally {
    await db.close();
    db = mainDb;
  }
}

/** 후보마다 독립 트랜잭션(begin … rollback)이다 — PGlite 는 savepoint 안 예외가 쌓이면 스택이 넘친다. */
async function exhaustiveIn(ctx: string, g: Game, s: GameState) {
  const legal = new Map<string, Move>();
  for (const m of legalMoves(s)) legal.set(`${m.from}:${m.to}:${m.piece}`, m);
  const tryPlay = async (from: number | null, to: number | null, piece: number | null) => {
    await db.exec('begin');
    try {
      await db.query('select public.tj_play($1, $2, $3, $4)', [g.id, from, to, piece]);
      const row = (await db.query<RoomRow>('select * from public.tj_rooms where id = $1', [g.id])).rows[0];
      await db.exec('reset role');
      row.pos_counts = await positions(g.id);
      await db.exec('set role authenticated');
      return { got: true, msg: '', row };
    } catch (e) {
      return { got: false, msg: (e as Error).message, row: null };
    } finally {
      await db.exec('rollback');
    }
  };
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [g.uidOf[s.turn]]);
  await db.exec('set role authenticated');
  try {
    for (let from = DROP; from < 12; from++) {
      for (let to = 0; to < 12; to++) {
        for (const piece of PIECE_OPTIONS) {
          const actual = from >= 0 && s.board[from] !== 0 ? Math.abs(s.board[from]) : null;
          const m = legal.get(from === DROP ? `${from}:${to}:${piece}` : `${from}:${to}:${actual}`);
          // 놓기는 종류가 꼭 있어야 하고, 이동은 생략하거나 실제 말과 같아야 한다
          const want = !!m && (from === DROP ? piece !== null : piece === null || piece === actual);
          const { got, msg, row } = await tryPlay(from, to, piece);
          exhaustiveCalls++;
          if (got !== want) {
            fail(`${ctx}: (${from}→${to}, piece ${piece}) 서버 ${got ? '통과' : '거부'} / 로컬 ${want ? '합법' : '불법'} @ ${formatBoard(s)} ${JSON.stringify(formatHand(s))} 차례 ${s.turn}`);
          } else if (!got && msg !== 'illegal move') fail(`${ctx}: (${from}→${to}, piece ${piece}) 거부 사유 '${msg}'`);
          else if (got && m) compare(`${ctx} 후보 ${moveKey(m)}`, row, applyMove(s, m), m, from === DROP ? 0 : s.board[to]);
        }
      }
    }
    // 범위 밖 인자
    const outside: [number | null, number | null][] = [[-2, 0], [12, 0], [0, -1], [0, 12], [null, 0], [0, null]];
    for (const [from, to] of outside) {
      const { got, msg } = await tryPlay(from, to, 2);
      if (got) fail(`${ctx}: 범위 밖 (${from}, ${to}) 통과`);
      else if (!msg.includes('illegal move')) fail(`${ctx}: 범위 밖 사유 ${msg}`);
    }
    // 상대는 합법 수라도 둘 수 없다
    const first = legalMoves(s)[0];
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [g.uidOf[other(s.turn)]]);
    const { got, msg } = await tryPlay(first.from, first.to, first.piece);
    if (got) fail(`${ctx}: 상대 차례에 착수 통과`);
    else if (!msg.includes('not your turn')) fail(`${ctx}: 상대 착수 사유 ${msg}`);
  } finally {
    await db.exec('reset role');
  }
}

{
  const rand = mulberry32(SEED);
  for (let gi = 0; gi < GAMES; gi++) {
    const g = await newGame();
    let s = createInitialState();
    let r = await room(g.host, g.id);
    compare(`g${gi} 시작`, r, s, null, 0);
    const mode = gi % 4; // 0 무작위 · 1 쉬움 · 2 보통 · 3 섞음
    for (let ply = 0; ply < 200 && s.phase !== 'over'; ply++) {
      if (rand() < SAMPLE) await exhaustive(`g${gi} ply${ply}`, g, s);
      hasMoveSamples.push({ board: Array.from(s.board), hand: Array.from(s.hand) });
      const moves = legalMoves(s);
      const m =
        mode === 0 || (mode === 3 && rand() < 0.5)
          ? moves[Math.floor(rand() * moves.length)]
          : (chooseMove(s, mode === 1 ? 'easy' : 'normal', { rng: rand, timeBudgetMs: Infinity, maxNodes: 4000 }) ?? moves[0]);
      const captured = m.from === DROP ? 0 : s.board[m.to];
      const pieceArg = m.from !== DROP && rand() < 0.3 ? null : m.piece; // 이동은 p_piece 생략도 섞는다
      const before = r?.version ?? -1;
      await rpc(g.uidOf[s.turn], 'tj_play', { p_room: g.id, p_from: m.from, p_to: m.to, p_piece: pieceArg });
      s = applyMove(s, m);
      r = await room(g.host, g.id);
      compare(`g${gi} ply${ply + 1}`, r, s, m, captured);
      if (r && r.version !== before + 1) fail(`g${gi} ply${ply + 1}: version ${before} → ${r.version}`);
      if (m.promote) bump('승격');
      if (m.from === DROP) bump('놓기');
      if (captured !== 0) bump(Math.abs(captured) === 5 ? '侯 잡기' : '잡기');
    }
    if (s.result) bump(s.result.kind === 'draw' ? 'draw:' + s.result.reason : 'win:' + s.result.reason);
    else {
      await rpc(g.uidOf[s.turn], 'tj_resign', { p_room: g.id });
      const rr = await room(g.host, g.id);
      if (rr?.status !== 'finished' || rr.win_reason !== 'resign') fail(`g${gi}: 기권 처리 ${rr?.status} ${rr?.win_reason}`);
      bump('미종료→기권');
    }
  }
  ok(`무작위 대국 ${GAMES}판 매 ply 서버 = 로컬 — ${JSON.stringify(stats)}`);
  ok(`표본 국면 ${exhaustivePositions}개 × 모든 인자(${exhaustiveCalls}번 호출): 받는 수 = legalMoves, 결과 = applyMove`);
}

/* ── 6. tj_has_move · tj_pos_key 대조 ─────────────────────────────────── */
{
  const rand = mulberry32(SEED + 7);
  // 대국에서 모은 국면 + 손패를 무작위로 바꾼 국면 + 손패를 비운 국면(투입 분기까지)
  const samples = hasMoveSamples.slice(0, 3000).flatMap((x) => [
    x,
    { board: x.board, hand: x.hand.map(() => Math.floor(rand() * 3)) },
    { board: x.board, hand: [0, 0, 0, 0, 0, 0] },
  ]);
  samples.push({ board: Array.from(makeState({ board: 'RB. KRB PPk ...', turn: 1 }).board), hand: [0, 0, 0, 0, 0, 0] });
  let n = 0;
  for (const x of samples) {
    for (const side of [1, 2] as const) {
      const st = stateFrom(x.board, x.hand, side);
      const want = hasLegalMove(st);
      const got = (await su<{ h: boolean }>('select public.tj_has_move($1::smallint[], $2::smallint[], $3) as h', [x.board, x.hand, side]))[0].h;
      if (got !== want) fail(`tj_has_move ${formatBoard(st)} ${x.hand} side ${side}: 서버 ${got} / 로컬 ${want}`);
      n++;
    }
  }
  ok(`tj_has_move ${n}가지 = hasLegalMove`);

  const byText = new Map<string, number>();
  const byKey = new Map<number, string>();
  for (const x of samples.slice(0, 2000)) {
    for (const side of [1, 2] as const) {
      const st = stateFrom(x.board, x.hand, side);
      const text = (await su<{ k: string }>('select public.tj_pos_key($1::smallint[], $2::smallint[], $3) as k', [x.board, x.hand, side]))[0].k;
      if (text !== serverKey(st)) fail(`tj_pos_key 모양 ${text} / ${serverKey(st)}`);
      if (byText.has(text) && byText.get(text) !== st.key) fail(`tj_pos_key 충돌 ${text}`);
      if (byKey.has(st.key) && byKey.get(st.key) !== text) fail(`computeKey 같고 서버 키 다름 ${text}`);
      byText.set(text, st.key);
      byKey.set(st.key, text);
    }
  }
  ok(`tj_pos_key ↔ computeKey 일대일(${byText.size}개 국면)`);
}

/* ── 7. 방 흐름 · 오류 · 시간초과 · 정리 · 제약 ─────────────────────────── */

/** updated_at · turn_started_at 을 과거로 돌린다(갱신 트리거를 잠시 끄고). */
async function backdate(sql: string, params: unknown[]) {
  await su('alter table public.tj_rooms disable trigger tj_rooms_touch');
  await su(sql, params);
  await su('alter table public.tj_rooms enable trigger tj_rooms_touch');
}

{
  const host = uid();
  const guest = uid();
  const third = uid();
  await expectErr('이름 없음', host, 'tj_create_room', { p_display_name: '  \t ' }, 'display name required');
  await expectErr('세션 없음', null, 'tj_create_room', { p_display_name: 'x' }, 'not authenticated');
  const c = await rpc<Entered>(host, 'tj_create_room', { p_display_name: '  긴이름'.padEnd(40, '가') });
  const pl = await asUser(host, 'authenticated', async () => (await db.query<Row>('select * from public.tj_room_players where room_id = $1', [c.room_id])).rows);
  if (pl[0].display_name.length !== 24 || pl[0].display_name.startsWith(' ')) fail('이름 정리(trim·24자) 안 됨: ' + pl[0].display_name);
  // 비회원은 RLS 로 방이 안 보인다
  if ((await room(guest, c.room_id)) !== undefined) fail('비회원에게 방이 보임');
  await expectErr('시작 전 착수', host, 'tj_play', { p_room: c.room_id, p_from: 7, p_to: 4, p_piece: 4 }, 'not playing');
  await expectErr('혼자 시작', host, 'tj_start_game', { p_room: c.room_id }, 'need 2 players');
  await expectErr('없는 코드', guest, 'tj_join_room', { p_code: 'NOPE00', p_display_name: 'g' }, 'room not found');
  const j = await rpc<Entered>(guest, 'tj_join_room', { p_code: ` ${c.code.toLowerCase()} `, p_display_name: 'g' });
  if (j.seat !== 1) fail('두 번째 참가자 좌석 ' + j.seat);
  await expectErr('세 번째 참가', third, 'tj_join_room', { p_code: c.code, p_display_name: 't' }, 'room is full');
  await expectErr('비방장 시작', guest, 'tj_start_game', { p_room: c.room_id }, 'only host can start');
  // 대기실에서 방장이 나가면 남은 사람이 방장
  await rpc(host, 'tj_leave_room', { p_room: c.room_id });
  let r = await room(guest, c.room_id);
  if (r?.host_id !== guest) fail('방장 승계 안 됨');
  await rpc(host, 'tj_join_room', { p_code: c.code, p_display_name: 'h' }); // 빈 좌석 0 으로 다시
  await expectErr('옛 방장이 시작', host, 'tj_start_game', { p_room: c.room_id }, 'only host can start');
  await rpc(guest, 'tj_start_game', { p_room: c.room_id });
  await expectErr('두 번 시작', guest, 'tj_start_game', { p_room: c.room_id }, 'not in lobby');
  await expectErr('시작 후 남이 참가', third, 'tj_join_room', { p_code: c.code, p_display_name: 't' }, 'game already started');
  await expectErr('비회원 착수', third, 'tj_play', { p_room: c.room_id, p_from: 7, p_to: 4, p_piece: 4 }, 'not a member');
  r = await room(guest, c.room_id);
  const greenUid = r?.green_seat === 0 ? host : guest; // 좌석 0 = host(재참가), 1 = guest
  const redUid = greenUid === host ? guest : host;
  // 시간초과
  await expectErr('내 차례에 시간초과 주장', greenUid, 'tj_claim_timeout', { p_room: c.room_id }, 'your turn');
  await expectErr('이른 시간초과', redUid, 'tj_claim_timeout', { p_room: c.room_id }, 'not timed out yet');
  await backdate(`update public.tj_rooms set turn_started_at = now() - interval '121 seconds' where id = $1`, [c.room_id]);
  await expectErr('비회원 시간초과', third, 'tj_claim_timeout', { p_room: c.room_id }, 'not a member');
  await rpc(redUid, 'tj_claim_timeout', { p_room: c.room_id });
  r = await room(guest, c.room_id);
  const redSeat = redUid === host ? 0 : 1;
  if (r?.status !== 'finished' || r.win_reason !== 'timeout' || r.winner_seat !== redSeat) fail(`시간초과 결과 ${r?.status} ${r?.win_reason} ${r?.winner_seat}`);
  await rpc(greenUid, 'tj_resign', { p_room: c.room_id }); // 끝난 방 기권은 그대로
  if ((await room(guest, c.room_id))?.win_reason !== 'timeout') fail('끝난 방 기권이 결과를 바꿈');
  await expectErr('끝난 방 비회원 참가', third, 'tj_join_room', { p_code: c.code, p_display_name: 't' }, 'room closed');
  const rejoin = await rpc<Entered>(host, 'tj_join_room', { p_code: c.code, p_display_name: 'h2' });
  if (rejoin.seat !== 0) fail('끝난 방 재접속 좌석');
  // 대국 중 나가기 = 연결만 내림
  const g = await newGame();
  await rpc(g.guest, 'tj_leave_room', { p_room: g.id });
  const gp = await asUser(g.host, 'authenticated', async () => (await db.query<Row>('select * from public.tj_room_players where room_id = $1 order by seat', [g.id])).rows);
  if (gp.length !== 2 || gp[1].connected !== false) fail('대국 중 나가기가 좌석을 지움');
  await rpc(g.guest, 'tj_join_room', { p_code: g.code, p_display_name: '다시' });
  const gp2 = await asUser(g.host, 'authenticated', async () => (await db.query<Row>('select connected from public.tj_room_players where room_id = $1 and seat = 1', [g.id])).rows);
  if (gp2[0].connected !== true) fail('재접속이 connected 를 올리지 않음');
  // 기권 — 녹(차례)이 기권
  const loserSeat = (await room(g.host, g.id))?.green_seat ?? -1;
  await rpc(g.uidOf[1], 'tj_resign', { p_room: g.id });
  r = await room(g.host, g.id);
  if (r?.win_reason !== 'resign' || r.winner_seat !== 1 - loserSeat) fail('기권 승자');
  // 대기실에서 둘 다 나가면 abandoned
  const h2 = uid();
  const c2 = await rpc<Entered>(h2, 'tj_create_room', { p_display_name: 'x' });
  await rpc(h2, 'tj_leave_room', { p_room: c2.room_id });
  if ((await su('select status from public.tj_rooms where id = $1', [c2.room_id]))[0].status !== 'abandoned') fail('빈 방이 abandoned 가 아님');
  // 들어갈 때 server_now 를 준다
  {
    const hx = uid();
    const cx = await rpc<Entered>(hx, 'tj_create_room', { p_display_name: 'x' });
    const jx = await rpc<Entered>(uid(), 'tj_join_room', { p_code: cx.code, p_display_name: 'y' });
    const rx = await rpc<Entered>(hx, 'tj_join_room', { p_code: cx.code, p_display_name: 'x' });
    for (const [n, v] of [['create', cx], ['join', jx], ['rejoin', rx]] as const) {
      if (!Number.isFinite(Date.parse(v.server_now))) fail(`${n}: server_now 없음 ${JSON.stringify(v)}`);
    }
  }
  // 기권·시간초과로 끝나도 반복 행은 지워진다
  {
    const gr = await newGame();
    await rpc(gr.uidOf[1], 'tj_resign', { p_room: gr.id });
    if (Object.keys(await positions(gr.id)).length !== 0) fail('기권 뒤 반복 행이 남음');
    const gt = await newGame();
    await backdate(`update public.tj_rooms set turn_started_at = now() - interval '121 seconds' where id = $1`, [gt.id]);
    await rpc(gt.uidOf[2], 'tj_claim_timeout', { p_room: gt.id });
    if (Object.keys(await positions(gt.id)).length !== 0) fail('시간초과 뒤 반복 행이 남음');
  }
  // 온라인 판 길이 상한: 999 ply 까지 이어 온 판에서 끝나지 않는 수를 두면 무승부(movelimit)
  {
    const gm = await newGame();
    await su('update public.tj_rooms set move_count = 998 where id = $1', [gm.id]);
    await rpc(gm.uidOf[1], 'tj_play', { p_room: gm.id, p_from: 11, p_to: 8, p_piece: 2 });
    let rm = await room(gm.host, gm.id);
    if (rm?.status !== 'playing' || rm.move_count !== 999) fail(`999 ply 에서 끝남 ${rm?.status} ${rm?.move_count}`);
    await rpc(gm.uidOf[2], 'tj_play', { p_room: gm.id, p_from: 0, p_to: 3, p_piece: 2 });
    rm = await room(gm.host, gm.id);
    if (rm?.status !== 'finished' || !rm.is_draw || rm.draw_reason !== 'movelimit' || rm.move_count !== 1000) {
      fail(`1000 ply 상한 ${rm?.status} ${rm?.is_draw} ${rm?.draw_reason} ${rm?.move_count}`);
    }
    if (Object.keys(rm?.pos_counts ?? {}).length !== 0) fail('상한 무승부 뒤 반복 행이 남음');
    // 상한 ply 에서도 王 잡기 등 다른 판정이 먼저다
    const gk = await newGame();
    await su('update public.tj_rooms set move_count = 996 where id = $1', [gk.id]);
    for (const [side, f, t, pc] of [[1, 7, 4, 4], [2, 1, 4, 1], [1, 10, 7, 1], [2, 4, 7, 1]] as const) {
      await rpc(gk.uidOf[side], 'tj_play', { p_room: gk.id, p_from: f, p_to: t, p_piece: pc });
    }
    const rk = await room(gk.host, gk.id);
    if (rk?.win_reason !== 'capture' || rk.is_draw || rk.move_count !== 1000) fail(`상한 ply 의 王 잡기 ${rk?.win_reason} ${rk?.draw_reason}`);
  }
  // 정리는 한 번에 오래된 20방까지
  {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push((await rpc<Entered>(uid(), 'tj_create_room', { p_display_name: 'old' + i })).room_id);
    await backdate(`update public.tj_rooms set updated_at = now() - interval '3 hours' where id = any($1::uuid[])`, [ids]);
    // 다른 검사가 남긴 오래된 방도 섞일 수 있으니 이 25방 중 남은 수로 본다
    const count = async () => (await su<{ n: number }>('select count(*)::int n from public.tj_rooms where id = any($1::uuid[])', [ids]))[0].n;
    const before = await count();
    const otherOld = (await su<{ n: number }>(`select count(*)::int n from public.tj_rooms where not (id = any($1::uuid[])) and (
        (status = 'lobby' and updated_at < now() - interval '2 hours') or (status = 'finished' and updated_at < now() - interval '24 hours')
        or (status = 'abandoned' and updated_at < now() - interval '1 hour') or (status = 'playing' and updated_at < now() - interval '6 hours'))`, [ids]))[0].n;
    await rpc(uid(), 'tj_create_room', { p_display_name: 'c1' });
    const after1 = await count();
    if (before !== 25 || before - after1 !== Math.max(0, 20 - otherOld)) fail(`정리 1회 ${before}→${after1} (다른 오래된 방 ${otherOld})`);
    await rpc(uid(), 'tj_create_room', { p_display_name: 'c2' });
    await rpc(uid(), 'tj_create_room', { p_display_name: 'c3' });
    const after3 = await count();
    if (after3 !== 0) fail(`정리 3회 뒤에도 ${after3}방 남음`);
  }
  // 반복 횟수 표는 회원도 못 읽는다
  try {
    await asUser(host, 'authenticated', () => db.query('select * from public.tj_room_positions'));
    fail('authenticated 가 tj_room_positions 를 읽었다');
  } catch (e) {
    if (!(e as Error).message.includes('permission denied')) fail('tj_room_positions 읽기: ' + (e as Error).message);
  }
  // 대기실 활동(참가·재접속·나가기)은 방 수명을 늘린다 — 만든 지 오래된 대기실이라도 사람이 드나들면 정리되지 않는다
  {
    const h3 = uid();
    const g3 = uid();
    const c3 = await rpc<Entered>(h3, 'tj_create_room', { p_display_name: 'h' });
    const back = () => backdate(`update public.tj_rooms set updated_at = now() - interval '119 minutes' where id = $1`, [c3.room_id]);
    const fresh = async (label: string) => {
      const age = (await su<{ s: number }>(`select extract(epoch from now() - updated_at) as s from public.tj_rooms where id = $1`, [c3.room_id]))[0].s;
      if (!(Number(age) < 60)) fail(`${label} 뒤 updated_at 이 그대로(${age}초 전)`);
    };
    await back();
    await rpc(g3, 'tj_join_room', { p_code: c3.code, p_display_name: 'g' });
    await fresh('대기실 참가');
    await back();
    await rpc(g3, 'tj_join_room', { p_code: c3.code, p_display_name: 'g2' });
    await fresh('대기실 재접속');
    await back();
    await rpc(g3, 'tj_leave_room', { p_room: c3.room_id });
    await fresh('대기실 나가기');
    await back();
    await rpc(uid(), 'tj_create_room', { p_display_name: 'cleaner' }); // 2시간 기준 정리가 돌아도
    if ((await su<{ n: number }>('select count(*)::int n from public.tj_rooms where id = $1', [c3.room_id]))[0].n !== 1) fail('119분 된 대기실이 지워짐');
  }
  // 방 만들기 제한
  const spam = uid();
  for (let i = 0; i < 10; i++) await rpc(spam, 'tj_create_room', { p_display_name: 's' });
  await expectErr('방 만들기 제한', spam, 'tj_create_room', { p_display_name: 's' }, 'too many rooms');
  // 정리: 오래된 방만 지운다
  await backdate(`update public.tj_rooms set updated_at = now() - interval '25 hours' where id = $1`, [c.room_id]); // finished 25h
  await backdate(`update public.tj_rooms set updated_at = now() - interval '23 hours' where id = $1`, [g.id]); // finished 23h
  await rpc(uid(), 'tj_create_room', { p_display_name: 'cleaner' });
  const left = (await su<{ id: string }>('select id from public.tj_rooms where id in ($1, $2)', [c.room_id, g.id])).map((x) => x.id);
  if (left.includes(c.room_id) || !left.includes(g.id)) fail('정리 기준 틀림: ' + JSON.stringify(left));
  if ((await su<{ n: number }>('select count(*)::int n from public.tj_room_players where room_id = $1', [c.room_id]))[0].n !== 0) fail('정리 후 좌석이 남음');
  // CHECK 제약
  for (const [name, stmt] of [
    ['판 길이', `update public.tj_rooms set board = '{1,2}' where id = '${g.id}'`],
    ['판 값', `update public.tj_rooms set board[1] = 6 where id = '${g.id}'`],
    ['판 null', `update public.tj_rooms set board[1] = null where id = '${g.id}'`],
    ['손패 값', `update public.tj_rooms set hand[1] = 3 where id = '${g.id}'`],
    ['손패 음수', `update public.tj_rooms set hand[6] = -1 where id = '${g.id}'`],
    ['결과 없는 종료', `update public.tj_rooms set win_reason = null where id = '${g.id}'`],
    ['진행 중 승자', `update public.tj_rooms set status = 'playing' where id = '${g.id}'`],
    ['2차원 판', `update public.tj_rooms set board = '{{1,2},{3,4}}' where id = '${g.id}'`],
  ]) {
    try {
      await su(stmt);
      fail(`CHECK 통과: ${name}`);
    } catch (e) {
      if (!/check constraint|violates/.test((e as Error).message)) fail(`CHECK ${name}: ${(e as Error).message}`);
    }
  }
  ok('방 흐름·오류 문구·시간초과·나가기·기권·정리·제한·CHECK');
}

/* ── 8. 피드백 ─────────────────────────────────────────────────────────── */
{
  const meta = JSON.stringify({ app_version: '0.1.0', screen: 'lobby', hint_used: false });
  const u = uid();
  await rpc(u, 'tj_submit_feedback', { p_kind: 'bug', p_message: '안녕', p_contact: ' ', p_meta: meta, p_hp: '' }, 'anon');
  await rpc(u, 'tj_submit_feedback', { p_kind: 'bug', p_message: '봇', p_contact: null, p_meta: '{}', p_hp: 'x' }, 'anon');
  await expectErr('세션 없는 피드백', null, 'tj_submit_feedback', { p_kind: 'bug', p_message: 'x', p_contact: null, p_meta: '{}', p_hp: '' }, 'not authenticated', 'anon');
  await expectErr('종류 틀림', u, 'tj_submit_feedback', { p_kind: 'x', p_message: 'x', p_contact: null, p_meta: '{}', p_hp: '' }, 'invalid kind', 'anon');
  for (let i = 0; i < 4; i++) await rpc(u, 'tj_submit_feedback', { p_kind: 'other', p_message: 'm' + i, p_contact: null, p_meta: '{}', p_hp: '' });
  await expectErr('피드백 제한', u, 'tj_submit_feedback', { p_kind: 'other', p_message: 'm', p_contact: null, p_meta: '{}', p_hp: '' }, 'too many submissions');
  // 전역 하루 500건
  await su(`insert into public.tj_feedback(user_id, kind, message, created_at)
            select gen_random_uuid(), 'other', 'x', now() - interval '2 hours' from generate_series(1, 495)`);
  await expectErr('피드백 하루 총량', uid(), 'tj_submit_feedback', { p_kind: 'other', p_message: 'm', p_contact: null, p_meta: '{}', p_hp: '' }, 'feedback quota exhausted');
  // 세션별 하루 20건(10분 상한은 피하도록 2시간 전 기록으로 채운다)
  await su('delete from public.tj_feedback');
  const heavy = uid();
  await su(`insert into public.tj_feedback(user_id, kind, message, created_at)
            select $1::uuid, 'other', 'x', now() - interval '2 hours' from generate_series(1, 20)`, [heavy]);
  await expectErr('세션별 하루 상한', heavy, 'tj_submit_feedback', { p_kind: 'other', p_message: 'm', p_contact: null, p_meta: '{}', p_hp: '' }, 'too many submissions');
  await rpc(uid(), 'tj_submit_feedback', { p_kind: 'other', p_message: '다른 사람', p_contact: null, p_meta: '{}', p_hp: '' });
  // (위에서 표를 비웠으므로 저장 모양은 따로 확인한다)
  const u2 = uid();
  await rpc(u2, 'tj_submit_feedback', { p_kind: 'bug', p_message: '모양', p_contact: ' ', p_meta: meta, p_hp: '' }, 'anon');
  const fb = await su('select * from public.tj_feedback where user_id = $1', [u2]);
  if (fb.length !== 1 || fb[0].contact !== null || fb[0].screen !== 'lobby' || fb[0].hint_used !== false) fail('피드백 저장 ' + JSON.stringify(fb[0]));
  ok('피드백 RPC');
}

await db.close();
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${failures === 0 ? '✅ 전부 통과' : `❌ 실패 ${failures}건`} (${secs}초)`);
process.exit(failures === 0 ? 0 : 1);
