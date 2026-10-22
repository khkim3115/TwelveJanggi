-- ============================================================================
-- 십이장기 온라인 1:1 대전 백엔드 (Supabase / Postgres)
--
-- 적용 대상: 요트다이스·나인 멘스 모리스와 **공유하는** Supabase 프로젝트. 이 파일의 객체는 전부
-- `tj_` 접두사를 쓰며 기존 객체(rooms·room_players·leaderboard·feedback·room_status·nmm_*)를 건드리지 않는다.
--
-- ⚠️ 권한은 tj_ 객체 이름을 하나씩 적어서만 바꾼다. `on all ... in schema`, `alter default privileges` 같은
--    전역 문은 절대 넣지 말 것 — 다른 게임의 권한이 통째로 바뀐다. `create extension` 문도 넣지 않는다
--    (pgcrypto 는 이미 extensions 스키마에 있다).
--
-- 설계: 서버 권위. 합법성(이동·놓기·승격)과 판정(王 잡기 → 입성 → 3회 반복 → 둘 수 없음 → 온라인 상한
--       1000 ply)을 전부 서버가 하고,
--       클라이언트 직접 쓰기는 revoke + RLS 로 막는다. 규칙은 src/core(board.ts · gameState.ts · rules.ts)와
--       같아야 한다 — 어느 쪽이든 고쳤으면 `npm run test:sql -- --deep`(로컬)과 `npm run e2e:mp`(실서버)로 대조할 것.
-- ============================================================================

-- ── 스키마 ───────────────────────────────────────────────────────────────
-- 상태값은 enum 대신 text + CHECK — 기존 room_status enum 과 얽히지 않게.
create table if not exists public.tj_rooms (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  status          text not null default 'lobby'
                    check (status in ('lobby','playing','finished','abandoned')),
  host_id         uuid not null,

  -- 녹(선공, 진영 1)을 맡은 좌석. 시작할 때 무작위로 정해 선공을 공평하게 나눈다.
  green_seat      smallint check (green_seat in (0,1)),
  -- 지금 둘 진영(1 = 녹, 2 = 적). 좌석이 아니라 진영이라 green_seat 와 조합해 차례를 판정한다.
  turn            smallint check (turn in (1,2)),

  -- 12칸 부호 코드: +k 녹 / −k 적 / 0 빈칸 (王1 將2 相3 子4 侯5). 인덱스는 src/core/board.ts 순서
  -- (i = 행*3 + 열, 행 0 = 적 진영)이고, SQL 배열이 1-based 라 board[i + 1] 로 읽는다. 기본값은 시작 국면.
  board           smallint[] not null default '{-2,-1,-3,0,-4,0,0,4,0,3,1,2}'
                    check (array_ndims(board) = 1 and array_lower(board, 1) = 1 and array_length(board, 1) = 12
                           and array_position(board, null) is null and -5 <= all(board) and 5 >= all(board)),
  -- 손패 개수 [녹 將·相·子, 적 將·相·子] — 클라이언트 GameState.hand 와 같은 이름·순서.
  hand            smallint[] not null default '{0,0,0,0,0,0}'
                    check (array_ndims(hand) = 1 and array_lower(hand, 1) = 1 and array_length(hand, 1) = 6
                           and array_position(hand, null) is null and 0 <= all(hand) and 2 >= all(hand)),

  move_count      int not null default 0,
  -- 직전 수 {from, to, piece, promote, captured}. from = -1 이면 손패 놓기, piece 는 승격 전 종류,
  -- captured 는 잡힌 말의 부호 코드(없으면 0) — 클라이언트가 잡기 표시(×)를 다시 계산하지 않게 싣는다.
  last_move       jsonb check (last_move is null or jsonb_typeof(last_move) = 'object'),

  winner_seat     smallint check (winner_seat in (0,1)),
  win_reason      text check (win_reason in ('capture','try','blocked','resign','timeout')),
  is_draw         boolean not null default false,
  -- movelimit 은 온라인 대전만의 판 길이 상한(rules.ts ONLINE_MAX_PLIES, tj__advance).
  draw_reason     text check (draw_reason in ('repetition','movelimit')),

  turn_started_at timestamptz,
  -- 행이 바뀔 때마다 1씩 오른다(트리거). 클라이언트가 늦게 도착한 스냅샷으로 새 상태를 덮지 않게 비교하는 값.
  version         int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint tj_rooms_started check (
    status in ('lobby','abandoned') or (green_seat is not null and turn is not null and turn_started_at is not null)),
  constraint tj_rooms_result check (
    case when status = 'finished'
      then (is_draw and draw_reason is not null and winner_seat is null and win_reason is null)
        or (not is_draw and draw_reason is null and winner_seat is not null and win_reason is not null)
      else not is_draw and draw_reason is null and winner_seat is null and win_reason is null
    end)
);
-- 정리(tj_cleanup_rooms)가 상태별로 오래된 방을 찾는다. code 는 unique 제약이 이미 색인한다.
create index if not exists tj_rooms_status_idx on public.tj_rooms (status, updated_at);

-- 반복 판정용 국면 등장 횟수(국면 키 tj_pos_key → 횟수). 시작 국면도 1회로 센다(tj_start_game).
-- 방 행에 jsonb 로 두지 않는다 — 방 행은 Realtime 으로 매 수 통째로 나가고(replica identity full) WAL 에도 두 번
-- 남는데, 잡은 말이 손패로 돌아오는 규칙이라 판이 길수록 커지는 값을 실으면 수마다 비용이 커진다.
-- 여기 두면 한 수에 작은 행 하나만 바뀐다. 판이 끝나면 지우고(tj__advance·tj_resign·tj_claim_timeout),
-- 판 길이는 온라인 상한(1000 ply)으로 묶여 한 방의 행 수도 묶인다. Realtime 에 싣지 않고, 정책 없이 RLS 만 켠다.
create table if not exists public.tj_room_positions (
  room_id  uuid not null references public.tj_rooms(id) on delete cascade,
  pos_key  text not null check (char_length(pos_key) <= 64),
  -- 3회째에 무승부로 끝나므로 3을 넘지 않는다(rules.ts repetitionLimit).
  cnt      int not null check (cnt between 1 and 3),
  primary key (room_id, pos_key)
);

create table if not exists public.tj_room_players (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.tj_rooms(id) on delete cascade,
  user_id       uuid not null,
  seat          smallint not null check (seat in (0,1)),
  display_name  text not null check (char_length(display_name) between 1 and 24),
  is_host       boolean not null default false,
  connected     boolean not null default true,
  joined_at     timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (room_id, user_id),
  unique (room_id, seat)
);

create or replace function public.tj_touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;

drop trigger if exists tj_rooms_touch on public.tj_rooms;
create trigger tj_rooms_touch before update on public.tj_rooms
  for each row execute function public.tj_touch_updated_at();

-- ── 순수 규칙 (src/core/board.ts · gameState.ts 포팅) ─────────────────────
-- 칸 i 의 행 = i / 3, 열 = i % 3. 진영 side 에게 상대 진영인 행(farRow) = side 1 → 0, side 2 → 3.

-- side 의 kind 말이 from 에서 to 로 한 걸음에 갈 수 있는가(점유 여부 무관) — board.ts canStep.
-- 방향은 말 주인 기준(앞 = 행 −1)이고, 적은 판을 180° 돌린 것이라 행·열 변화의 부호를 모두 뒤집어 본다.
create or replace function public.tj_can_step(p_side int, p_kind int, p_from int, p_to int)
returns boolean language sql immutable set search_path = public as $$
  select coalesce((
    select case p_kind
      when 1 then greatest(abs(dr), abs(dc)) = 1                             -- 王 8방향
      when 2 then abs(dr) + abs(dc) = 1                                      -- 將 상하좌우
      when 3 then abs(dr) = 1 and abs(dc) = 1                                -- 相 대각
      when 4 then dr = -1 and dc = 0                                         -- 子 앞
      when 5 then greatest(abs(dr), abs(dc)) = 1 and not (dr = 1 and dc <> 0) -- 侯 뒤쪽 대각을 뺀 6방향
      else false
    end
    from (select (p_to / 3 - p_from / 3) * sgn as dr, (p_to % 3 - p_from % 3) * sgn as dc
          from (select case p_side when 1 then 1 when 2 then -1 end as sgn) s) d
    where p_from between 0 and 11 and p_to between 0 and 11
  ), false);
$$;

-- side 가 둘 수(손패 놓기 포함)가 하나라도 있는가 — gameState.hasLegalMove 와 같은 구조.
create or replace function public.tj_has_move(p_board smallint[], p_hand smallint[], p_side int)
returns boolean language plpgsql immutable set search_path = public as $$
declare
  f int; t int; v int; w int;
  far int := case when p_side = 1 then 0 else 3 end;
  base int := (p_side - 1) * 3;
begin
  for f in 0..11 loop
    v := p_board[f + 1];
    if v <> 0 and (v > 0) = (p_side = 1) then
      for t in 0..11 loop
        if public.tj_can_step(p_side, abs(v), f, t) then
          w := p_board[t + 1];
          if w = 0 or (w > 0) <> (p_side = 1) then return true; end if;
        end if;
      end loop;
    end if;
  end loop;
  if p_hand[base + 1] + p_hand[base + 2] + p_hand[base + 3] = 0 then return false; end if;
  for t in 0..11 loop
    if p_board[t + 1] = 0 and t / 3 <> far then return true; end if;
  end loop;
  return false;
end $$;

-- 반복 판정용 국면 키(판 + 양쪽 손패 + 차례). 해시가 아니라 정확한 문자열이라 충돌이 없다 —
-- 클라이언트 computeKey(정확한 정수)와 모양은 달라도 같은 국면을 같은 키로 묶는다.
create or replace function public.tj_pos_key(p_board smallint[], p_hand smallint[], p_turn int)
returns text language sql immutable set search_path = public as $$
  select array_to_string(p_board, ',') || '|' || array_to_string(p_hand, ',') || '|' || p_turn;
$$;

create or replace function public.tj_roll_seat()
returns smallint language sql volatile set search_path = public, extensions as $$
  select (get_byte(gen_random_bytes(1), 0) % 2)::smallint;
$$;

create or replace function public.tj_generate_code()
returns text language plpgsql volatile set search_path = public, extensions as $$
declare alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; gen_code text; i int; attempts int := 0;
begin
  loop
    gen_code := '';
    for i in 1..6 loop
      gen_code := gen_code || substr(alphabet, (get_byte(gen_random_bytes(1), 0) % length(alphabet)) + 1, 1);
    end loop;
    -- code 는 상태와 무관하게 unique 다 — 끝난 방의 코드와 겹쳐도 insert 가 실패하므로 모든 상태를 본다.
    if not exists (select 1 from public.tj_rooms where code = gen_code) then
      return gen_code;
    end if;
    attempts := attempts + 1;
    if attempts > 20 then raise exception 'could not allocate room code'; end if;
  end loop;
end $$;

-- ── 차례 확인 · 수 적용 후 판정 ────────────────────────────────────────────

-- 내 좌석과 진영을 확인하고 "지금 내 차례"가 아니면 예외. 반환값은 내 진영(1 = 녹, 2 = 적).
create or replace function public.tj__require_turn(r public.tj_rooms, uid uuid)
returns int language plpgsql stable set search_path = public as $$
declare my_seat smallint; my_side int;
begin
  if r.status <> 'playing' then raise exception 'not playing'; end if;
  select seat into my_seat from public.tj_room_players where room_id = r.id and user_id = uid;
  if my_seat is null then raise exception 'not a member'; end if;
  my_side := case when my_seat = r.green_seat then 1 else 2 end;
  if my_side <> r.turn then raise exception 'not your turn'; end if;
  return my_side;
end $$;

-- 대기실 활동(참가·재접속·나가기)은 좌석 표만 바꿔 방 행의 updated_at 이 그대로다. 정리(tj_cleanup_rooms)가
-- 사람이 모여 있는 대기실을 "만든 지 2시간"으로 지우지 않게 방 행을 건드린다(트리거가 updated_at·version 을 올린다).
create or replace function public.tj__touch(p_room uuid)
returns void language sql set search_path = public as $$
  update public.tj_rooms set updated_at = now() where id = p_room;
$$;

-- 한 수를 둔 직후의 판정 — 클라이언트 gameState.detectResult 와 같은 순서(rules.ts 머리말):
--   1. 王 이 잡혔다                                  → 잡은 쪽 승  (capture)
--   2. 차례가 돌아온 쪽의 王 이 상대 진영에 있다      → 그쪽 승     (try: 들어간 뒤 한 턴을 버텼다)
--   3. 같은 국면(판 + 양쪽 손패 + 차례)이 3회째      → 무승부      (repetition, 시작 국면도 1회로 센다)
--   4. 차례가 된 쪽이 둘 수(놓기 포함)가 하나도 없다  → 상대 승     (blocked)
-- 그 뒤에 온라인 대전만의 상한이 하나 더 있다: 위 넷으로 끝나지 않은 채 1000 ply 에 이르면 무승부(movelimit).
-- 사람이 두는 판은 여기까지 가지 않는다 — 판 하나가 공유 DB 에 끝없이 쌓이지 않게 하는 안전장치다(rules.ts).
-- 판·손패는 tj_play 가 계산해 넘기고, 이 함수가 차례·직전 수·결과를 방 행 UPDATE 한 번으로 쓴다 —
-- 그래야 Realtime 구독자가 "판은 바뀌었는데 차례는 그대로"인 중간 상태를 보지 않는다.
create or replace function public.tj__advance(
  r public.tj_rooms, p_board smallint[], p_hand smallint[], p_last jsonb, p_captured int)
returns void language plpgsql set search_path = public as $$
declare
  mover int := r.turn;
  nxt int := 3 - r.turn;
  pkey text := public.tj_pos_key(p_board, p_hand, 3 - r.turn);
  reps int;            -- 이 국면의 등장 횟수(이번 포함)
  king_at int;
  winner int;          -- 이긴 진영(1 = 녹, 2 = 적). 아직 안 끝났거나 무승부면 null.
  reason text;
  draw boolean := false;
  dreason text;
begin
  -- 방 행을 tj_play 가 잠가 두었으므로 같은 방의 수는 한 줄로 선다 — 횟수가 엇갈리지 않는다.
  insert into public.tj_room_positions as p (room_id, pos_key, cnt) values (r.id, pkey, 1)
    on conflict (room_id, pos_key) do update set cnt = p.cnt + 1
    returning p.cnt into reps;

  if abs(p_captured) = 1 then
    winner := mover; reason := 'capture';
  else
    king_at := array_position(p_board, (case when nxt = 1 then 1 else -1 end)::smallint) - 1;
    if king_at is not null and king_at / 3 = (case when nxt = 1 then 0 else 3 end) then
      winner := nxt; reason := 'try';
    elsif reps >= 3 then
      draw := true; dreason := 'repetition';
    elsif not public.tj_has_move(p_board, p_hand, nxt) then
      winner := mover; reason := 'blocked';
    elsif r.move_count + 1 >= 1000 then
      draw := true; dreason := 'movelimit';
    end if;
  end if;

  update public.tj_rooms set
    board = p_board,
    hand = p_hand,
    turn = nxt,
    move_count = r.move_count + 1,
    last_move = p_last,
    turn_started_at = now(),
    status = case when winner is not null or draw then 'finished' else 'playing' end,
    winner_seat = case when winner is null then null
                       when winner = 1 then r.green_seat else 1 - r.green_seat end,
    win_reason = reason,
    is_draw = draw,
    draw_reason = dreason
  where id = r.id;
  -- 끝난 판의 반복 횟수는 더 쓸 일이 없다 — 방이 정리될 때까지(최대 24시간) 남겨 두지 않는다.
  if winner is not null or draw then
    delete from public.tj_room_positions where room_id = r.id;
  end if;
end $$;

-- ── RLS ──────────────────────────────────────────────────────────────────
create or replace function public.tj_is_room_member(p_room uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.tj_room_players where room_id = p_room and user_id = auth.uid()
  );
$$;

alter table public.tj_rooms enable row level security;
alter table public.tj_room_players enable row level security;
alter table public.tj_room_positions enable row level security;

drop policy if exists tj_rooms_select_member on public.tj_rooms;
create policy tj_rooms_select_member on public.tj_rooms
  for select to authenticated using (public.tj_is_room_member(id));

drop policy if exists tj_players_select_member on public.tj_room_players;
create policy tj_players_select_member on public.tj_room_players
  for select to authenticated using (public.tj_is_room_member(room_id));

-- 이 프로젝트의 기본 ACL 은 새 테이블에 anon·authenticated 전 권한(TRUNCATE 포함)을 준다 — 전부 회수하고
-- 회원 읽기(RLS)만 연다. 쓰기는 아래 SECURITY DEFINER RPC 로만 한다. 반복 횟수 표는 읽기도 막는다.
revoke all on table public.tj_rooms, public.tj_room_players, public.tj_room_positions from public, anon, authenticated;
grant select on table public.tj_rooms, public.tj_room_players to authenticated;

-- ── 정리 (pg_cron 이 없어 tj_create_room 이 부른다) ─────────────────────────
-- tj_ 방만 지운다(다른 게임의 방은 건드리지 않는다). 지워진 방의 Realtime DELETE 는 필터가 걸리지 않아
-- 다른 방 구독자에게도 가므로, 클라이언트는 payload.old.id 가 제 방일 때만 처리한다.
-- 한 번에 오래된 순으로 20방까지만 — 방을 만드는 사람이 쌓인 정리 비용을 한꺼번에 떠안지 않게 한다.
create or replace function public.tj_cleanup_rooms()
returns void language plpgsql set search_path = public as $$
begin
  delete from public.tj_rooms where id in (
    select id from public.tj_rooms where
         (status = 'lobby'     and updated_at < now() - interval '2 hours')
      or (status = 'finished'  and updated_at < now() - interval '24 hours')
      or (status = 'abandoned' and updated_at < now() - interval '1 hour')
      or (status = 'playing'   and updated_at < now() - interval '6 hours')
    order by updated_at
    limit 20);
end $$;

-- ── RPC (쓰기 표면 전부) ─────────────────────────────────────────────────

create or replace function public.tj_create_room(p_display_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  name text := regexp_replace(coalesce(p_display_name, ''), '^\s+|\s+$', '', 'g');
  new_id uuid; new_code text;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if char_length(name) = 0 then raise exception 'display name required'; end if;
  -- 세션당 5분에 10개(best-effort 스팸 방지 — 공유 DB 라 방이 끝없이 쌓이지 않게).
  if (select count(*) from public.tj_rooms
        where host_id = uid and created_at > now() - interval '5 minutes') >= 10 then
    raise exception 'too many rooms';
  end if;
  perform public.tj_cleanup_rooms();
  new_code := public.tj_generate_code();
  insert into public.tj_rooms(code, status, host_id)
    values (new_code, 'lobby', uid) returning id into new_id;
  insert into public.tj_room_players(room_id, user_id, seat, display_name, is_host)
    values (new_id, uid, 0, left(name, 24), true);
  -- server_now: 클라이언트가 기기 시계와 서버 시계의 차이를 처음부터 알 수 있게(남은 시간·시간초과 표시).
  return jsonb_build_object('room_id', new_id, 'code', new_code, 'seat', 0, 'server_now', now());
end $$;

create or replace function public.tj_join_room(p_code text, p_display_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  name text := regexp_replace(coalesce(p_display_name, ''), '^\s+|\s+$', '', 'g');
  r public.tj_rooms; existing public.tj_room_players; new_seat smallint;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if char_length(name) = 0 then raise exception 'display name required'; end if;
  select * into r from public.tj_rooms where code = upper(btrim(coalesce(p_code, ''))) for update;
  if not found then raise exception 'room not found'; end if;

  select * into existing from public.tj_room_players where room_id = r.id and user_id = uid;
  if found then
    -- 재접속(새로고침·잠깐 끊김): 좌석을 그대로 두고 다시 붙는다.
    update public.tj_room_players
      set display_name = left(name, 24), last_seen_at = now(), connected = true
      where id = existing.id;
    if r.status = 'lobby' then perform public.tj__touch(r.id); end if;
    return jsonb_build_object('room_id', r.id, 'code', r.code, 'seat', existing.seat, 'server_now', now());
  end if;

  if r.status = 'playing' then raise exception 'game already started'; end if;
  if r.status <> 'lobby' then raise exception 'room closed'; end if;
  select min(s)::smallint into new_seat from generate_series(0, 1) s
    where s not in (select seat from public.tj_room_players where room_id = r.id);
  if new_seat is null then raise exception 'room is full'; end if;
  insert into public.tj_room_players(room_id, user_id, seat, display_name, is_host)
    values (r.id, uid, new_seat, left(name, 24), false);
  perform public.tj__touch(r.id);
  return jsonb_build_object('room_id', r.id, 'code', r.code, 'seat', new_seat, 'server_now', now());
end $$;

create or replace function public.tj_start_game(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  r public.tj_rooms; ncount int;
  start_board smallint[] := '{-2,-1,-3,0,-4,0,0,4,0,3,1,2}';   -- board.ts INITIAL_BOARD
  start_hand smallint[] := '{0,0,0,0,0,0}';
begin
  select * into r from public.tj_rooms where id = p_room for update;
  if not found then raise exception 'room not found'; end if;
  if uid is null or r.host_id <> uid then raise exception 'only host can start'; end if;
  if r.status <> 'lobby' then raise exception 'not in lobby'; end if;
  select count(*) into ncount from public.tj_room_players where room_id = r.id;
  if ncount < 2 then raise exception 'need 2 players'; end if;

  update public.tj_rooms set
    status = 'playing',
    -- 선공(녹)을 무작위로 — 방장이 늘 먼저 두지 않게.
    green_seat = public.tj_roll_seat(),
    turn = 1,
    board = start_board,
    hand = start_hand,
    move_count = 0,
    last_move = null,
    winner_seat = null, win_reason = null, is_draw = false, draw_reason = null,
    turn_started_at = now()
  where id = r.id;
  -- 시작 국면도 반복 1회로 센다(클라이언트 createInitialState 와 같다). 비워 두고 시작하면
  -- 처음 국면으로 돌아오는 반복에서 무승부가 한 ply 늦어진다.
  delete from public.tj_room_positions where room_id = r.id;
  insert into public.tj_room_positions(room_id, pos_key, cnt)
    values (r.id, public.tj_pos_key(start_board, start_hand, 1), 1);
end $$;

-- 한 수 — 판 위 이동(p_from 0..11) 또는 손패 놓기(p_from = -1, gameState.DROP).
-- 규칙은 gameState.legalMoves · applyMoveInPlace 와 같다:
--  · 이동: 내 말을 한 걸음(tj_can_step), 내 말이 있는 칸 불가. 잡은 말은 내 손패로(侯 는 子 로 돌아가고 王 은
--    손패가 되지 않는다). 子 가 이동(잡기 포함)으로 상대 진영 행에 들어가면 강제로 侯 — 승격은 서버가 정한다.
--  · 놓기: 손패의 將·相·子 하나를 빈칸에. 상대 진영 행에는 놓을 수 없고, 놓기로는 승격하지 않는다.
--  · p_piece: 놓기에는 필수(놓을 종류), 이동에서는 null 이거나 판 위 말의 종류(승격 전)와 같아야 한다 —
--    클라이언트가 낡은 판을 보고 둔 수를 걸러 낸다.
create or replace function public.tj_play(p_room uuid, p_from int, p_to int, p_piece int)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  r public.tj_rooms;
  me int; far int;
  nb smallint[]; nh smallint[];
  v int; kind int; target int := 0; hi int; promoted boolean := false;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into r from public.tj_rooms where id = p_room for update;
  if not found then raise exception 'room not found'; end if;
  me := public.tj__require_turn(r, uid);
  far := case when me = 1 then 0 else 3 end;
  if p_to is null or p_to < 0 or p_to > 11 or p_from is null or p_from < -1 or p_from > 11 then
    raise exception 'illegal move';
  end if;
  nb := r.board;
  nh := r.hand;

  if p_from = -1 then
    if p_piece is null or p_piece not in (2, 3, 4) then raise exception 'illegal move'; end if;
    hi := (me - 1) * 3 + (p_piece - 2) + 1;
    if nh[hi] <= 0 or nb[p_to + 1] <> 0 or p_to / 3 = far then raise exception 'illegal move'; end if;
    nh[hi] := nh[hi] - 1;
    nb[p_to + 1] := (case when me = 1 then p_piece else -p_piece end)::smallint;
    kind := p_piece;
  else
    v := nb[p_from + 1];
    if v = 0 or (v > 0) <> (me = 1) then raise exception 'illegal move'; end if;
    kind := abs(v);
    if p_piece is not null and p_piece <> kind then raise exception 'illegal move'; end if;
    if not public.tj_can_step(me, kind, p_from, p_to) then raise exception 'illegal move'; end if;
    target := nb[p_to + 1];
    if target <> 0 and (target > 0) = (me = 1) then raise exception 'illegal move'; end if;
    if target <> 0 and abs(target) <> 1 then
      hi := (me - 1) * 3 + (case when abs(target) = 5 then 4 else abs(target) end) - 2 + 1;
      nh[hi] := nh[hi] + 1;
    end if;
    promoted := kind = 4 and p_to / 3 = far;
    nb[p_from + 1] := 0;
    nb[p_to + 1] := (case when me = 1 then 1 else -1 end * case when promoted then 5 else kind end)::smallint;
  end if;

  perform public.tj__advance(r, nb, nh,
    jsonb_build_object('from', p_from, 'to', p_to, 'piece', kind, 'promote', promoted, 'captured', target),
    target);
end $$;

create or replace function public.tj_resign(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); r public.tj_rooms; my_seat smallint;
begin
  select * into r from public.tj_rooms where id = p_room for update;
  if not found then raise exception 'room not found'; end if;
  select seat into my_seat from public.tj_room_players where room_id = r.id and user_id = uid;
  if my_seat is null then raise exception 'not a member'; end if;
  if r.status <> 'playing' then return; end if;
  update public.tj_rooms
    set status = 'finished', winner_seat = 1 - my_seat, win_reason = 'resign'
  where id = r.id;
  delete from public.tj_room_positions where room_id = r.id;
end $$;

-- 상대가 제한 시간(120초, 서버 상수) 안에 두지 않으면 기다린 쪽이 이긴다. 시간을 인자로 받지 않는다 —
-- 받으면 클라이언트가 짧게 줄여 부를 수 있다.
create or replace function public.tj_claim_timeout(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); r public.tj_rooms; my_seat smallint; cur_seat smallint;
begin
  select * into r from public.tj_rooms where id = p_room for update;
  if not found then raise exception 'room not found'; end if;
  select seat into my_seat from public.tj_room_players where room_id = r.id and user_id = uid;
  if my_seat is null then raise exception 'not a member'; end if;
  if r.status <> 'playing' then return; end if;
  cur_seat := case when r.turn = 1 then r.green_seat else 1 - r.green_seat end;
  if cur_seat = my_seat then raise exception 'your turn'; end if;
  if r.turn_started_at > now() - interval '120 seconds' then raise exception 'not timed out yet'; end if;
  update public.tj_rooms
    set status = 'finished', winner_seat = my_seat, win_reason = 'timeout'
  where id = r.id;
  delete from public.tj_room_positions where room_id = r.id;
end $$;

create or replace function public.tj_leave_room(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  r public.tj_rooms; me public.tj_room_players; remaining int; new_host public.tj_room_players;
begin
  select * into r from public.tj_rooms where id = p_room for update;
  if not found then return; end if;
  select * into me from public.tj_room_players where room_id = r.id and user_id = uid;
  if not found then return; end if;

  if r.status = 'lobby' then
    delete from public.tj_room_players where id = me.id;
    -- 사람이 바뀌었다 — 대기실 채팅을 지운다. 읽기는 '지금 회원'만 보므로, 남겨 두면 같은 코드로 다음에 들어오는
    -- 사람이 떠난 사람의 대화를 읽는다(#11). 대국 중·끝난 방은 좌석을 남기므로 그대로 둔다.
    delete from public.tj_chat where room_id = r.id;
    select count(*) into remaining from public.tj_room_players where room_id = r.id;
    if remaining = 0 then
      update public.tj_rooms set status = 'abandoned' where id = r.id;
    elsif me.is_host then
      select * into new_host from public.tj_room_players where room_id = r.id order by seat limit 1;
      update public.tj_room_players set is_host = true where id = new_host.id;
      update public.tj_rooms set host_id = new_host.user_id where id = r.id;
    else
      perform public.tj__touch(r.id);
    end if;
  else
    -- 대국 중·종료 뒤에는 좌석을 남겨(재접속·결과 확인) 연결 상태만 내린다.
    update public.tj_room_players set connected = false, last_seen_at = now() where id = me.id;
  end if;
end $$;

-- ── 사용자 피드백 ────────────────────────────────────────────────────────
-- 다른 게임의 feedback 테이블을 공유하지 않고 별도 테이블을 쓴다(기존 스키마 무수정 원칙).
-- 읽기 정책이 없으므로 API 로는 아무도 못 읽는다 — 운영자는 Table Editor(서비스 롤)에서만 확인.
create table if not exists public.tj_feedback (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid,
  kind         text not null check (kind in ('bug','feature','other')),
  message      text not null check (char_length(message) between 1 and 2000),
  contact      text check (contact is null or char_length(contact) <= 200),
  app_version  text check (app_version is null or char_length(app_version) <= 40),
  screen       text check (screen is null or char_length(screen) <= 40),
  hint_used    boolean,
  user_agent   text check (user_agent is null or char_length(user_agent) <= 500),
  status       text not null default 'new' check (status in ('new','triaged','done','spam')),
  created_at   timestamptz not null default now()
);
create index if not exists tj_feedback_triage_idx on public.tj_feedback (status, created_at desc);
-- 아래 제출 제한(세션별·전역 분당·전역 하루)이 세는 범위.
create index if not exists tj_feedback_created_idx on public.tj_feedback (created_at);
create index if not exists tj_feedback_user_idx on public.tj_feedback (user_id, created_at);

alter table public.tj_feedback enable row level security;
revoke all on table public.tj_feedback from public, anon, authenticated;

-- 클라이언트 src/lib/feedback.ts(buildFeedbackArgs · MAX_FEEDBACK_*)와 검증 값을 맞출 것.
create or replace function public.tj_submit_feedback(
  p_kind text, p_message text, p_contact text default null,
  p_meta jsonb default '{}'::jsonb, p_hp text default '')
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  -- 허니팟: 숨김 필드가 채워졌으면 봇 → 성공인 척 조용히 무시.
  if coalesce(p_hp, '') <> '' then return; end if;
  if uid is null then raise exception 'not authenticated'; end if;
  if p_kind is null or p_kind not in ('bug','feature','other') then raise exception 'invalid kind'; end if;
  if char_length(coalesce(p_message, '')) < 1 or char_length(p_message) > 2000 then
    raise exception 'message length must be 1..2000';
  end if;
  if p_contact is not null and char_length(p_contact) > 200 then raise exception 'contact too long'; end if;
  if p_meta is not null and length(p_meta::text) > 4000 then raise exception 'meta too large'; end if;
  -- 세션당 10분 5건 + 전역 분당 30건(best-effort 스팸 방지).
  if (select count(*) from public.tj_feedback
        where user_id = uid and created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'too many submissions';
  end if;
  if (select count(*) from public.tj_feedback
        where created_at > now() - interval '1 minute') >= 30 then
    raise exception 'too many submissions';
  end if;
  -- 세션당 하루 20건 — 아래 전역 하루 상한을 세션 하나가 혼자 채워 다른 사람을 막지 못하게.
  if (select count(*) from public.tj_feedback
        where user_id = uid and created_at > now() - interval '1 day') >= 20 then
    raise exception 'too many submissions';
  end if;
  -- 전역 하루 500건 — 분당 상한만으로는 익명 세션을 여럿 돌려 총량을 끝없이 쌓을 수 있다(공유 DB 디스크 보호).
  -- 보낸 적 없는 사람도 걸리므로 문구를 따로 둔다(FeedbackModal 이 GitHub 링크로 안내한다).
  if (select count(*) from public.tj_feedback
        where created_at > now() - interval '1 day') >= 500 then
    raise exception 'feedback quota exhausted';
  end if;
  insert into public.tj_feedback(user_id, kind, message, contact, app_version, screen, hint_used, user_agent)
  values (
    uid, p_kind, left(p_message, 2000),
    nullif(btrim(coalesce(p_contact, '')), ''),
    nullif(left(coalesce(p_meta->>'app_version', ''), 40), ''),
    nullif(left(coalesce(p_meta->>'screen', ''), 40), ''),
    case when jsonb_typeof(p_meta->'hint_used') = 'boolean' then (p_meta->>'hint_used')::boolean else null end,
    nullif(left(coalesce(p_meta->>'user_agent', ''), 500), '')
  );
end $$;

-- ── 채팅 (#11) ───────────────────────────────────────────────────────────
-- 공개 broadcast 채널은 방 UUID 와 anon 키만 알면 누구나 읽을 수 있고 보낸 사람도 꾸밀 수 있었다 — 테이블 + RPC 로 옮긴다.
-- 보내기는 tj_send_chat 하나(보낸 사람 · 이름은 서버가 tj_room_players 에서 채운다), 읽기는 회원만(RLS select · Realtime).
-- 클라이언트 src/lib/chat.ts(CHAT_MAX_LEN · CHAT_COLUMNS)와 값을 맞출 것.
create table if not exists public.tj_chat (
  id            bigint generated always as identity primary key,
  room_id       uuid not null references public.tj_rooms(id) on delete cascade,
  user_id       uuid not null,
  display_name  text not null check (char_length(display_name) between 1 and 24),
  body          text not null check (char_length(body) between 1 and 200),
  created_at    timestamptz not null default now()
);
-- 진입 · 재연결 때 최근 메시지 읽기와 방마다 200개 정리가 쓴다.
create index if not exists tj_chat_room_idx on public.tj_chat (room_id, id);
-- 아래 도배 제한이 세는 범위.
create index if not exists tj_chat_sender_idx on public.tj_chat (room_id, user_id, created_at);

alter table public.tj_chat enable row level security;
revoke all on table public.tj_chat from public, anon, authenticated;
revoke all on sequence public.tj_chat_id_seq from public, anon, authenticated;
grant select on table public.tj_chat to authenticated;

drop policy if exists tj_chat_select_member on public.tj_chat;
create policy tj_chat_select_member on public.tj_chat
  for select to authenticated using (public.tj_is_room_member(room_id));

create or replace function public.tj_send_chat(p_room uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  name text;
  msg text := regexp_replace(coalesce(p_body, ''), '^\s+|\s+$', '', 'g');
begin
  if uid is null then raise exception 'not authenticated'; end if;
  -- 방 행을 잠가 tj_leave_room(for update)과 줄을 세운다 — 나가며 대기실 채팅을 지우는 사이에 회원 확인을 마친
  -- 메시지가 지운 뒤에 남는 일이 없게. 수 두기와 겹쳐도 짧게 기다릴 뿐이다.
  perform 1 from public.tj_rooms where id = p_room for key share;
  -- 회원이면 대국 중에 나갔거나(connected = false) 끝난 방이어도 보낼 수 있다.
  select display_name into name from public.tj_room_players where room_id = p_room and user_id = uid;
  if name is null then raise exception 'not a member'; end if;
  if char_length(msg) = 0 then raise exception 'empty message'; end if;
  msg := left(msg, 200);
  -- 같은 방 · 같은 사용자 10초에 10개(best-effort 도배 방지).
  if (select count(*) from public.tj_chat
        where room_id = p_room and user_id = uid and created_at > now() - interval '10 seconds') >= 10 then
    raise exception 'too many messages';
  end if;
  insert into public.tj_chat(room_id, user_id, display_name, body) values (p_room, uid, name, msg);
  -- 방마다 최근 200개만 남긴다(방이 정리되면 cascade 로 모두 지워진다).
  delete from public.tj_chat where room_id = p_room and id <= (
    select id from public.tj_chat where room_id = p_room order by id desc offset 200 limit 1);
end $$;

-- ── 실행 권한 ────────────────────────────────────────────────────────────
-- 함수는 만들 때 PUBLIC 과(이 프로젝트의 기본 ACL 로) anon·authenticated 에 EXECUTE 가 붙는다.
-- tj_ 함수를 하나씩 적어 셋 모두에서 회수한 뒤, 필요한 것만 다시 연다(전역 문 금지 — 머리말 참고).
revoke execute on function
  public.tj_touch_updated_at(),
  public.tj_can_step(int, int, int, int),
  public.tj_has_move(smallint[], smallint[], int),
  public.tj_pos_key(smallint[], smallint[], int),
  public.tj_roll_seat(),
  public.tj_generate_code(),
  public.tj__require_turn(public.tj_rooms, uuid),
  public.tj__touch(uuid),
  public.tj__advance(public.tj_rooms, smallint[], smallint[], jsonb, int),
  public.tj_is_room_member(uuid),
  public.tj_cleanup_rooms(),
  public.tj_create_room(text),
  public.tj_join_room(text, text),
  public.tj_start_game(uuid),
  public.tj_play(uuid, int, int, int),
  public.tj_resign(uuid),
  public.tj_claim_timeout(uuid),
  public.tj_leave_room(uuid),
  public.tj_submit_feedback(text, text, text, jsonb, text),
  public.tj_send_chat(uuid, text)
from public, anon, authenticated;

-- 게임 RPC 는 로그인(익명 세션 포함 — 익명 사용자도 authenticated 롤이다) 사용자만.
-- tj_is_room_member 는 RLS select 정책과 Realtime 인가에서 호출되므로 authenticated 가 실행할 수 있어야 한다.
grant execute on function
  public.tj_is_room_member(uuid),
  public.tj_create_room(text),
  public.tj_join_room(text, text),
  public.tj_start_game(uuid),
  public.tj_play(uuid, int, int, int),
  public.tj_resign(uuid),
  public.tj_claim_timeout(uuid),
  public.tj_leave_room(uuid),
  public.tj_send_chat(uuid, text)
to authenticated;

-- 피드백은 솔로 화면에서도 보낸다(익명 세션이 auth.uid() 를 채운다).
grant execute on function public.tj_submit_feedback(text, text, text, jsonb, text) to anon, authenticated;

-- ── Realtime (Postgres Changes) ──────────────────────────────────────────
alter table public.tj_rooms replica identity full;
alter table public.tj_room_players replica identity full;
-- tj_chat 은 기본값(PK)으로 둔다 — INSERT 만 받으면 되고, DELETE 이벤트에는 필터 · RLS 가 걸리지 않아 full 이면
-- 200개 정리 · 방 정리 때 본문이 구독자 모두에게 샌다.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tj_rooms'
  ) then
    alter publication supabase_realtime add table public.tj_rooms;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tj_room_players'
  ) then
    alter publication supabase_realtime add table public.tj_room_players;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tj_chat'
  ) then
    alter publication supabase_realtime add table public.tj_chat;
  end if;
end $$;
