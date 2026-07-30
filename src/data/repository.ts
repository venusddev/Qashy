import type {
  Account,
  AppSettings,
  Budget,
  BudgetStatus,
  Category,
  CsvImportRow,
  DashboardSummary,
  EntityType,
  ExchangeRate,
  FinanceState,
  Goal,
  GoalContribution,
  ImportResult,
  RecurringRule,
  Tag,
  TransactionQuery,
  TransactionRecord,
} from '@/domain/models';
import type { RepairNote, SyncOpBody } from '@/sync/oplog';
import type { DuplicateGroup } from '@/sync/engine/duplicates';

export interface MergeResult {
  /** Records tombstoned because they turned out to be a copy of another one. */
  readonly merged: number;
  /** Records rewritten to point at the survivor instead — the merge's blast radius. */
  readonly retargeted: number;
}

export interface OnboardingInput {
  locale: string;
  baseCurrency: string;
  accountName: string;
  accountType: Account['type'];
  openingBalanceMinor: number;
  themeMode: AppSettings['themeMode'];
  accentSource: AppSettings['accentSource'];
  accentHex: string;
}

export type AccountInput = Omit<Account, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
export type CategoryInput = Omit<Category, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
export type TagInput = Omit<Tag, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
export type BudgetInput = Omit<Budget, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
export type GoalInput = Omit<Goal, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
export type ContributionInput = Omit<GoalContribution, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
export type GoalContributionInput = Omit<ContributionInput, 'goalId'>;
export type RecurringInput = Omit<RecurringRule, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'pausedByDependency'>;
export type RateInput = Omit<ExchangeRate, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
export type SettingsInput = Partial<Pick<AppSettings, 'locale' | 'baseCurrency' | 'themeMode' | 'accentSource' | 'accentHex'>>;

export interface TransactionInput {
  kind: TransactionRecord['kind'];
  status?: TransactionRecord['status'];
  title: string;
  note?: string;
  localDate: string;
  accountId: string;
  destinationAccountId?: string | null;
  categoryId?: string | null;
  tagIds?: string[];
  amountMinor: number;
  destinationAmountMinor?: number | null;
  destinationBaseAmountMinor?: number | null;
  exchangeRate?: string;
  recurringRuleId?: string | null;
  occurrenceKey?: string | null;
}

export interface ApplyResult {
  /** Ops folded into the causal state. A batch applies whole or not at all. */
  readonly applied: number;
  /** So the sync engine can coalesce a burst of batches into one hydrate. */
  readonly changedTypes: readonly EntityType[];
  /** What the deterministic repair pass had to fix to make the merged set valid. */
  readonly repairs: readonly RepairNote[];
}

export interface FinanceRepository {
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  applyRemoteOps(ops: readonly SyncOpBody[]): Promise<ApplyResult>;
  /**
   * Recomputes the repair pass over the stored op log, writing only what moved.
   *
   * Repairs are a pure function of the merged set and are re-derived from scratch every pass,
   * which is what lets them *un*-apply: an account resurrected because a merged-in transaction
   * referenced it goes back to tombstoned the moment that transaction does. But a merge only
   * runs when a peer sends something, and the edit that removes a repair's cause is very often
   * local — deleting that transaction on this device. Without this, the device that made the
   * edit keeps the stale repair while every peer that received it drops one, and they disagree
   * until some unrelated batch happens to arrive.
   *
   * Emits no ops and applies none: `applied` is always 0.
   */
  repairProjection(): Promise<ApplyResult>;
  getSnapshot(): FinanceState;
  subscribe(listener: () => void): () => void;
  completeOnboarding(input: OnboardingInput): Promise<void>;
  updateSettings(patch: SettingsInput, expectedRevision?: number): Promise<AppSettings>;
  saveAccount(input: AccountInput, id?: string, expectedRevision?: number): Promise<Account>;
  saveCategory(input: CategoryInput, id?: string, expectedRevision?: number): Promise<Category>;
  saveTag(input: TagInput, id?: string, expectedRevision?: number): Promise<Tag>;
  saveTransaction(input: TransactionInput, id?: string, expectedRevision?: number): Promise<TransactionRecord>;
  saveBudget(input: BudgetInput, id?: string, expectedRevision?: number): Promise<Budget>;
  saveGoal(input: GoalInput, id?: string, expectedRevision?: number): Promise<Goal>;
  saveGoalAndContribution(input: GoalInput, contribution?: GoalContributionInput, id?: string, expectedRevision?: number): Promise<Goal>;
  saveContribution(input: ContributionInput, id?: string, expectedRevision?: number): Promise<GoalContribution>;
  saveRecurringRule(input: RecurringInput, id?: string, expectedRevision?: number): Promise<RecurringRule>;
  saveExchangeRate(input: RateInput, id?: string, expectedRevision?: number): Promise<ExchangeRate>;
  queryTransactions(query?: TransactionQuery, snapshot?: TransactionRecord[]): TransactionRecord[];
  getDashboard(fromDate: string, toDate: string): DashboardSummary;
  getBudgetStatuses(onDate: string, options?: { includeInactiveCustom?: boolean }): BudgetStatus[];
  getGoalProgress(goalId: string): number;
  generateRecurring(horizonDate?: string): Promise<number>;
  confirmUpcoming(id: string): Promise<void>;
  skipUpcoming(id: string): Promise<void>;
  updateTransactionsCategory(ids: string[], categoryId: string | null): Promise<void>;
  deleteEntities(type: keyof FinanceState, ids: string[]): Promise<void>;
  /**
   * Collapses user-confirmed duplicates into one record each, atomically.
   *
   * Pair two devices that both already hold data and you get two of everything the user
   * created on both. Nothing here is automatic: `suggestDuplicates` proposes the groups, the
   * merge review screen is where they are confirmed, and this applies exactly what was
   * confirmed. Throws — writing nothing — if a group is one the merged vault cannot express,
   * such as two same-named accounts held in different currencies.
   */
  mergeDuplicates(groups: readonly DuplicateGroup[]): Promise<MergeResult>;
  importCsv(rows: CsvImportRow[], commit?: boolean): Promise<ImportResult>;
  exportCsv(): string;
  resetAllData(): Promise<void>;
}
