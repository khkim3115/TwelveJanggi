// 피드백 순수 로직: 입력 검증 · 보조 GitHub 링크 빌더 · RPC 인자 변환.
// (네트워크/Supabase 호출은 대상 아님 — 서버 검증은 schema.sql 의 submit_feedback 가 담당)
import { describe, it, expect } from 'vitest';
import {
  buildFeedbackArgs,
  buildGithubIssueUrl,
  MAX_FEEDBACK_MESSAGE,
  validateFeedbackMessage,
} from './feedback';

describe('validateFeedbackMessage', () => {
  it('빈 내용/공백만 있으면 거부한다', () => {
    expect(validateFeedbackMessage('')).not.toBeNull();
    expect(validateFeedbackMessage('   ')).not.toBeNull();
  });
  it('2000자를 초과하면 거부한다', () => {
    expect(validateFeedbackMessage('a'.repeat(MAX_FEEDBACK_MESSAGE + 1))).not.toBeNull();
  });
  it('정상 내용은 통과(null)한다', () => {
    expect(validateFeedbackMessage('侯 로 승격이 안 될 때가 있어요')).toBeNull();
  });
});

describe('buildGithubIssueUrl', () => {
  it('레포의 issues/new 로 향한다', () => {
    const url = buildGithubIssueUrl('bug', '버그입니다');
    expect(url.startsWith('https://github.com/khkim3115/TwelveJanggi/issues/new?')).toBe(true);
  });
  it('메시지를 body 파라미터에 인코딩해 담는다(특수문자 포함)', () => {
    const url = buildGithubIssueUrl('bug', '한글 & 특수문자 test');
    const body = new URL(url).searchParams.get('body');
    expect(body).toContain('한글 & 특수문자 test');
  });
  it('권한 없는 사용자의 404 방지를 위해 labels/assignees 를 넣지 않는다', () => {
    const params = new URL(buildGithubIssueUrl('feature', '이런 기능 원해요')).searchParams;
    expect(params.has('labels')).toBe(false);
    expect(params.has('assignees')).toBe(false);
    expect(params.has('milestone')).toBe(false);
  });
  it('종류를 제목 접두로 표시한다', () => {
    const title = new URL(buildGithubIssueUrl('bug', 'x')).searchParams.get('title') ?? '';
    expect(title).toContain('[버그]');
  });
  it('제공된 메타(버전)를 body 에 포함한다', () => {
    const url = buildGithubIssueUrl('other', '의견', { app_version: '0.5.0' });
    expect(new URL(url).searchParams.get('body')).toContain('0.5.0');
  });
});

describe('buildFeedbackArgs', () => {
  it('메시지를 트림하고 빈 연락처는 null 로 보낸다', () => {
    const args = buildFeedbackArgs({ kind: 'bug', message: '  내용  ', contact: '   ' });
    expect(args.p_message).toBe('내용');
    expect(args.p_contact).toBeNull();
  });
  it('허니팟 값을 p_hp 로 그대로 전달한다', () => {
    const args = buildFeedbackArgs({ kind: 'bug', message: 'x', honeypot: 'bot-filled' });
    expect(args.p_hp).toBe('bot-filled');
  });
  it('연락처가 있으면 트림해서 전달한다', () => {
    const args = buildFeedbackArgs({ kind: 'other', message: 'x', contact: ' a@b.com ' });
    expect(args.p_contact).toBe('a@b.com');
  });
  it('종류를 p_kind 로 전달한다', () => {
    expect(buildFeedbackArgs({ kind: 'feature', message: 'x' }).p_kind).toBe('feature');
  });
});
