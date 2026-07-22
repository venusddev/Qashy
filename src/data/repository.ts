import type {
  Account,
  AppSettings,
  Budget,
  BudgetStatus,
  Category,
  CsvImportRow,
  DashboardSummary,
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

export interface FinanceRepository {
  initialize(): Promise<void>;
  refresh(): Promise<void>;
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
  importCsv(rows: CsvImportRow[], commit?: boolean): Promise<ImportResult>;
  exportCsv(): string;
  resetAllData(): Promise<void>;
}
