export interface NotifiableItem {
  id: string;
  title: string;
  kind?: string | null;
  pause_reason: string | null;
  resume_to: string | null;
}

export function diffWaiting(seen: readonly string[] | null, ids: readonly string[]): { fresh: string[]; seen: string[] };
export function bannerVisible(input: { supported: boolean; permission: string; dismissed: boolean; waiting: number }): boolean;
export function notificationFor(item: NotifiableItem, project: string): { title: string; body: string; tag: string };
