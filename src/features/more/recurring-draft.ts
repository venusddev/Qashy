import type { CategoryKind } from '@/domain/models';
import { makeId } from '@/utils/entity';

/**
 * One-navigation, in-memory handoff from a transaction draft to the recurring form.
 *
 * Finance data must never enter a route query. The opaque token is harmless if a browser keeps
 * it in history, while the values live only until the destination screen consumes them.
 */
export interface RecurringDraft {
  readonly kind: CategoryKind;
  readonly title: string;
  readonly amount: string;
  readonly accountId: string;
  readonly categoryId: string;
}

const drafts = new Map<string, RecurringDraft>();

export const stashRecurringDraft = (draft: RecurringDraft): string => {
  const id = makeId();
  drafts.set(id, draft);
  return id;
};

export const takeRecurringDraft = (id: string | undefined): RecurringDraft | null => {
  if (!id) return null;
  const draft = drafts.get(id) ?? null;
  drafts.delete(id);
  return draft;
};
