-- #11 채팅을 방 참가자 전용으로 — 공개 broadcast(채널 tj:<roomId>) 대신 tj_chat 테이블 + tj_send_chat RPC.
-- supabase/schema.sql 의 '채팅 (#11)' 절, 실행 권한 · Realtime 발행 줄, 바뀐 tj_leave_room 만 옮긴 델타다
-- (두 쪽이 같은 결과를 내는지 npm run test:sql 의 'schema.sql = migrations/' 대조가 본다).
-- 공유 프로젝트 — tj_ 객체만 만들고 바꾸며, 권한은 이름을 하나씩 적어 회수 · 부여한다.

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

revoke execute on function public.tj_send_chat(uuid, text) from public, anon, authenticated;
grant execute on function public.tj_send_chat(uuid, text) to authenticated;

-- 대기실에서 사람이 바뀌면 채팅을 지운다(다음에 들어오는 사람이 떠난 사람의 대화를 읽지 않게).
-- 시그니처가 같아 create or replace 가 함수를 바꾸고, 이미 있는 실행 권한은 그대로 남는다.
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

-- Realtime: INSERT 만 받는다. replica identity 는 기본값(PK) 그대로 — full 이면 필터 · RLS 가 걸리지 않는
-- DELETE 이벤트로 200개 정리 · 방 정리 때 본문이 샌다.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tj_chat'
  ) then
    alter publication supabase_realtime add table public.tj_chat;
  end if;
end $$;
