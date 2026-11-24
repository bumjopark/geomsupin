import type { KINDS, PRIORITIES, STATUSES } from './constants.ts';

export type Locale = 'ko' | 'en';

export function normalizeLocale(value: unknown): Locale {
  return value === 'en' ? 'en' : 'ko';
}

export const EN_REVIEW_TERMS = {
  접수: 'Open', 진행: 'In progress', 완료: 'Resolved', 재발생: 'Reopened', 보류: 'On hold',
  수정: 'Change', 추가: 'Addition', 문의: 'Question', 버그: 'Bug',
  긴급: 'Urgent', 높음: 'High', 보통: 'Normal', 낮음: 'Low',
} satisfies Record<(typeof KINDS | typeof PRIORITIES | typeof STATUSES)[number], string>;

export function reviewTerm(value: string, locale: Locale): string {
  return locale === 'en' && Object.hasOwn(EN_REVIEW_TERMS, value) ? EN_REVIEW_TERMS[value as keyof typeof EN_REVIEW_TERMS] : value;
}
