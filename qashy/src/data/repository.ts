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
export type RecurringInput = Omit<RecurringRule, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
export type RateInput = Omit<ExchangeRate, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

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
  exchangeRate?: string;
  recurringRuleId?: string | null;
  occurrenceKey?: string | null;
}

export interface FinanceRepository {
  initialize(): Promise<void>;
  getSnapshot(): FinanceState;
  subscribe(listener: () => void): () => void;
  completeOnboarding(input: OnboardingInput): Promise<void>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  saveAccount(input: AccountInput, id?: string): Promise<Account>;
  saveCategory(input: CategoryInput, id?: string): Promise<Category>;
  saveTag(input: TagInput, id?: string): Promise<Tag>;
  saveTransaction(input: TransactionInput, id?: string): Promise<TransactionRecord>;
  saveBudget(input: BudgetInput, id?: string): Promise<Budget>;
  saveGoal(input: GoalInput, id?: string): Promise<Goal>;
  saveContribution(input: ContributionInput, id?: string): Promise<GoalContribution>;
  saveRecurringRule(input: RecurringInput, id?: string): Promise<RecurringRule>;
  saveExchangeRate(input: RateInput, id?: string): Promise<ExchangeRate>;
  queryTransactions(query?: TransactionQuery): TransactionRecord[];
  getDashboard(fromDate: string, toDate: string): DashboardSummary;
  getBudgetStatuses(onDate: string): BudgetStatus[];
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
