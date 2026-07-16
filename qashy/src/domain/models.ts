export type CurrencyCode = string;

export type ThemeMode = 'system' | 'light' | 'dark';
export type AccentSource = 'system' | 'preset' | 'custom';
export type AccountType = 'cash' | 'checking' | 'savings' | 'credit' | 'wallet';
export type CategoryKind = 'expense' | 'income';
export type TransactionKind = 'expense' | 'income' | 'transfer';
export type TransactionStatus = 'posted' | 'upcoming' | 'skipped';
export type GoalKind = 'saving' | 'spending';
export type PeriodUnit = 'day' | 'week' | 'month' | 'year' | 'custom';
export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year';

export interface SyncEntity {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Money {
  minor: number;
  currency: CurrencyCode;
}

export interface AppSettings extends SyncEntity {
  onboardingComplete: boolean;
  locale: string;
  baseCurrency: CurrencyCode;
  themeMode: ThemeMode;
  accentSource: AccentSource;
  accentHex: string;
}

export interface Account extends SyncEntity {
  name: string;
  type: AccountType;
  currency: CurrencyCode;
  openingBalanceMinor: number;
  icon: string;
  color: string;
  archived: boolean;
}

export interface Category extends SyncEntity {
  name: string;
  kind: CategoryKind;
  icon: string;
  color: string;
  parentId: string | null;
  archived: boolean;
}

export interface Tag extends SyncEntity {
  name: string;
  color: string;
}

export interface TransactionRecord extends SyncEntity {
  kind: TransactionKind;
  status: TransactionStatus;
  title: string;
  note: string;
  localDate: string;
  accountId: string;
  destinationAccountId: string | null;
  categoryId: string | null;
  tagIds: string[];
  amountMinor: number;
  destinationAmountMinor: number | null;
  currency: CurrencyCode;
  destinationCurrency: CurrencyCode | null;
  exchangeRate: string;
  baseAmountMinor: number;
  transferGroupId: string | null;
  recurringRuleId: string | null;
  occurrenceKey: string | null;
}

export interface BudgetFilters {
  accountIds: string[];
  categoryIds: string[];
  tagIds: string[];
}

export interface PeriodDefinition {
  unit: PeriodUnit;
  interval: number;
  anchorDate: string;
  endDate: string | null;
}

export interface BudgetCategoryLimit {
  categoryId: string;
  limitMinor: number;
}

export interface Budget extends SyncEntity {
  name: string;
  icon: string;
  color: string;
  limitMinor: number;
  period: PeriodDefinition;
  rollover: boolean;
  filters: BudgetFilters;
  categoryLimits: BudgetCategoryLimit[];
  archived: boolean;
}

export interface BudgetPeriodSnapshot extends SyncEntity {
  budgetId: string;
  periodStart: string;
  periodEnd: string;
  limitMinor: number;
  rolloverMinor: number;
  filters: BudgetFilters;
  categoryLimits: BudgetCategoryLimit[];
}

export interface Goal extends SyncEntity {
  name: string;
  kind: GoalKind;
  icon: string;
  color: string;
  targetMinor: number;
  initialMinor: number;
  targetDate: string | null;
  linkedAccountId: string | null;
  linkedCategoryId: string | null;
  archived: boolean;
}

export interface GoalContribution extends SyncEntity {
  goalId: string;
  amountMinor: number;
  localDate: string;
  transactionId: string | null;
  note: string;
}

export interface RecurringTemplate {
  kind: Exclude<TransactionKind, 'transfer'>;
  title: string;
  note: string;
  accountId: string;
  categoryId: string | null;
  tagIds: string[];
  amountMinor: number;
  currency: CurrencyCode;
}

export interface RecurringRule extends SyncEntity {
  template: RecurringTemplate;
  unit: RecurrenceUnit;
  interval: number;
  startDate: string;
  endDate: string | null;
  nextDueDate: string;
  autoPost: boolean;
  active: boolean;
}

export interface ExchangeRate extends SyncEntity {
  fromCurrency: CurrencyCode;
  toCurrency: CurrencyCode;
  rate: string;
  effectiveDate: string;
}

export interface FinanceState {
  ready: boolean;
  settings: AppSettings;
  accounts: Account[];
  categories: Category[];
  tags: Tag[];
  transactions: TransactionRecord[];
  budgets: Budget[];
  budgetPeriods: BudgetPeriodSnapshot[];
  goals: Goal[];
  contributions: GoalContribution[];
  recurringRules: RecurringRule[];
  exchangeRates: ExchangeRate[];
}

export interface TransactionQuery {
  search?: string;
  accountIds?: string[];
  categoryIds?: string[];
  tagIds?: string[];
  kinds?: TransactionKind[];
  statuses?: TransactionStatus[];
  fromDate?: string;
  toDate?: string;
  minMinor?: number;
  maxMinor?: number;
  limit?: number;
  offset?: number;
  sort?: 'newest' | 'oldest' | 'amount-desc';
}

export interface DashboardSummary {
  netWorthMinor: number;
  incomeMinor: number;
  expenseMinor: number;
  netFlowMinor: number;
  budgetLimitMinor: number;
  budgetSpentMinor: number;
  accountBalances: { account: Account; balanceMinor: number }[];
  categorySpend: { category: Category | null; amountMinor: number }[];
  recentTransactions: TransactionRecord[];
  upcomingTransactions: TransactionRecord[];
  dailySpend: { date: string; amountMinor: number }[];
  missingExchangeRates: { fromCurrency: CurrencyCode; toCurrency: CurrencyCode }[];
}

export interface BudgetStatus {
  budget: Budget;
  snapshot: BudgetPeriodSnapshot;
  spentMinor: number;
  effectiveLimitMinor: number;
  categorySpend: { categoryId: string; amountMinor: number; limitMinor: number }[];
}

export interface CsvImportRow {
  rowNumber: number;
  date: string;
  type: TransactionKind;
  title: string;
  amount: string;
  currency: string;
  account: string;
  category: string;
  tags: string;
  note: string;
  exchangeRate: string;
  destinationAccount: string;
  destinationAmount: string;
  status?: TransactionStatus;
}

export interface ImportResult {
  validRows: CsvImportRow[];
  rejectedRows: { rowNumber: number; reason: string }[];
  duplicateRows: number[];
  warnings: string[];
  committedIds: string[];
}

export type EntityType =
  | 'settings'
  | 'accounts'
  | 'categories'
  | 'tags'
  | 'transactions'
  | 'budgets'
  | 'budgetPeriods'
  | 'goals'
  | 'contributions'
  | 'recurringRules'
  | 'exchangeRates';

export type FinanceEntity =
  | AppSettings
  | Account
  | Category
  | Tag
  | TransactionRecord
  | Budget
  | BudgetPeriodSnapshot
  | Goal
  | GoalContribution
  | RecurringRule
  | ExchangeRate;
