import type { Status } from '../../shared/constants.ts';

export interface Me {
  id: string;
  name: string;
  workspace: { id: string; name: string };
}

export interface Link {
  id: string;
  label: string;
  /** 같이 일하는 사람에게 보내는 검수 초대 주소 */
  shareUrl: string;
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
  createdAt: string;
}

/** 스테이징 연결과 요청을 관리하는 프로젝트. */
export interface Site {
  id: string;
  name: string;
  status: 'active' | 'done';
  widgetKey: string;
  preview?: { url: string; id: string };
  createdAt: string;
  openCount?: number;
  totalCount?: number;
  roundNo?: number;
  links?: Link[];
}

interface CaptureNotes {
  images?: number;
  iframes?: number;
  fonts?: number;
  failed?: boolean;
}

export interface Req {
  id: string;
  no: number;
  roundNo: number;
  kind: string;
  priority: string;
  status: Status;
  body: string;
  asIs: string | null;
  toBe: string | null;
  pageUrl: string;
  pageTitle: string;
  browser: string;
  os: string;
  viewportW: number | null;
  viewportH: number | null;
  reviewerName: string;
  assignee1: string;
  assignee2: string;
  resolutionNote: string;
  captureNotes: CaptureNotes;
  thumbUrl: string | null;
  createdAt: string;
  resolvedAt: string | null;
  commentCount: number;
  updatedAt: string;
  updatedBy: string;
  // 상세에서만
  comments?: Comment[];
  commentsBefore?: string | null;
  selector?: string;
  textHint?: string;
  dpr?: number | null;
  screenshotUrl?: string | null;
  proposalUrl?: string | null;
}

export interface Comment {
  id: string;
  type: 'reviewer' | 'agency' | 'system';
  author: string;
  body: string;
  createdAt: string;
}

export interface ListResponse {
  requests: Req[];
  total: number;
  counts: Record<string, number>;
  pages: { url: string; count: number }[];
  assignees: string[];
  rounds: { no: number; status: string }[];
}
