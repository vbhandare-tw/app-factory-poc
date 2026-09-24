export type CheckpointName = 'after_pm_refinement' | 'after_ticket_breakdown' | 'final_acceptance';

export type ReviewSection =
  | 'refined'
  | 'criteria'
  | 'notes'
  | 'plan'
  | 'tickets'
  | 'delivery'
  | 'explanation'
  | 'whatYouCanDo'
  | 'logs';

/** One `needs_human[]` entry of `GET /api/state`. */
export interface WaitingItem {
  id: string;
  title: string;
  status: string;
  kind: 'feature' | 'ticket' | null;
  pause_reason: string | null;
  pause_detail: string | null;
  resume_to: string | null;
  reject_to: string | null;
  paused_at: string | null;
}

export interface ReviewModel {
  checkpoint: CheckpointName | null;
  escalation: boolean;
  question: string;
  reasonLabel: string;
  sections: ReviewSection[];
  canApprove: boolean;
  noApproveText: string | null;
  approveLabel: string;
  canSendBack: boolean;
  sendBackText: string | null;
  noSendBackText: string | null;
  needsMergeConfirm: boolean;
  whatYouCanDo: string | null;
}

export interface ApproveResult {
  id: string;
  kind: 'feature' | 'ticket';
  from: string;
  to: string;
  path: string;
  held?: boolean;
}

export interface Outcome {
  tone: 'done' | 'waiting';
  title: string;
  message: string;
}

export interface PickUpOptions {
  external?: boolean;
  pollIntervalSec?: number;
}

export const CHECKPOINT_ROUTES: Readonly<Record<CheckpointName, { resumeTo: string; rejectTo: string }>>;
export const STANDING_APPROVAL: string;

export function checkpointOf(item: WaitingItem): CheckpointName | null;
export function reviewModel(item: WaitingItem, options?: { baseBranch?: string }): ReviewModel;
export function sendBackControl(model: ReviewModel, note: string): { show: boolean; disabled: boolean; hint: string | null };
export function mergeConfirmText(branches: { featureBranch: string; baseBranch: string }): string;
export function deliveredMessage(delivery: { featureBranch: string; baseBranch: string; tag: string | null }): string;
export function approveOutcome(result: ApproveResult, item: WaitingItem, options?: PickUpOptions): Outcome;
export function rejectOutcome(item: WaitingItem, options?: PickUpOptions): Outcome;
export function classifyFailure(status: number, message: string): 'handled' | 'error';
