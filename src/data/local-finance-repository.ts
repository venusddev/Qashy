import { Decimal } from 'decimal.js';

import { PlatformStorageAdapter } from '@/data/storage';
import type { StorageAdapter, StoredEntity } from '@/data/storage-adapter';
import { SyncingStorageAdapter } from '@/data/syncing-storage-adapter';
import type {
  Account,
  AppSettings,
  Budget,
  BudgetFilters,
  BudgetPeriodSnapshot,
  BudgetStatus,
  Category,
  CsvImportRow,
  DashboardSummary,
  EntityType,
  ExchangeRate,
  FinanceEntity,
  FinanceState,
  Goal,
  GoalContribution,
  ImportResult,
  RecurringRule,
  Tag,
  TransactionQuery,
  TransactionRecord,
} from '@/domain/models';
import type {
  AccountInput,
  BudgetInput,
  CategoryInput,
  ContributionInput,
  FinanceRepository,
  GoalInput,
  GoalContributionInput,
  OnboardingInput,
  RateInput,
  RecurringInput,
  SettingsInput,
  TagInput,
  TransactionInput,
} from '@/data/repository';
import {
  applyOps,
  changedTypes,
  finalize,
  isEntityType,
  materialize,
  metaKey,
  mergeMetaMaps,
  repairMergedState,
  type CausalMeta,
  type SyncOpBody,
} from '@/sync/oplog';
import { readAllStates, writeStates } from '@/data/sync-store';
import { planMerge, type DuplicateGroup } from '@/sync/engine/duplicates';
import { createDefaultCategories, createInitialState, defaultAccountName, initialSettings } from '@/domain/defaults';
import { canActivateRecurringRule } from '@/domain/rules';
import {
  addRecurrence,
  firstRecurrenceOnOrAfter,
  isLocalDate,
  parseLocalDate,
  todayLocal,
} from '@/utils/date';
import { budgetPeriodId, occurrenceTransactionId } from '@/utils/deterministic-id';
import { createEntity, makeId, nowIso, updateEntity } from '@/utils/entity';
import { disambiguateNames, normalizeName } from '@/utils/naming';
import { escapeCsv } from '@/utils/csv';
import { validateLocale } from '@/utils/form-validation';
import {
  addMinor,
  convertMinor,
  isSafeMinor,
  isSupportedCurrencyCode,
  minorToDecimalString,
  parseInvariantMoney,
  subtractMinor,
  sumMinor,
} from '@/utils/money';
import { resolvePeriod } from '@/utils/period';
// Not `from 'zod'` — see `src/utils/zod.ts`; the CSP leaves no `eval` for zod's JIT probe.
import { z } from '@/utils/zod';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_TYPES = ['cash', 'checking', 'savings', 'credit', 'wallet'] as const;
const CATEGORY_KINDS = ['expense', 'income'] as const;
const GOAL_KINDS = ['saving', 'spending'] as const;
const TRANSACTION_TYPES = ['expense', 'income', 'transfer'] as const;
const TRANSACTION_STATUSES = ['posted', 'upcoming', 'skipped'] as const;
const PERIOD_UNITS = ['day', 'week', 'month', 'year', 'custom'] as const;
const RECURRENCE_UNITS = ['day', 'week', 'month', 'year'] as const;
const THEME_MODES = ['system', 'light', 'dark'] as const;
const ACCENT_SOURCES = ['system', 'preset', 'custom'] as const;
const MAX_RECURRING_OCCURRENCES_PER_RUN = 100_000;
// How far a manually entered rate may sit from the reciprocal of an existing
// opposite-direction rate before the pair is treated as contradictory (2%).
const RECIPROCAL_RATE_TOLERANCE = 0.02;
// How far a manually entered transfer destination amount may sit from the
// rate-derived amount before it reads as a typo rather than spread (one order
// of magnitude either way).
const MANUAL_TRANSFER_AMOUNT_TOLERANCE = 10;
// Roughly a century of daily points. A dashboard range wider than this used to
// truncate the daily series silently and return a chart that was simply wrong.
const MAX_DASHBOARD_DAYS = 36_600;
const csvRowSchema = z.object({
  rowNumber: z.number(),
  date: z.string().regex(DATE_PATTERN).refine(isLocalDate, 'Enter a real calendar date.'),
  type: z.enum(TRANSACTION_TYPES),
  status: z.enum(TRANSACTION_STATUSES).default('posted'),
  title: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
  account: z.string().min(1),
  category: z.string().default(''),
  tags: z.string().default(''),
  note: z.string().default(''),
  exchangeRate: z.string().default(''),
  destinationAccount: z.string().default(''),
  destinationAmount: z.string().default(''),
  destinationBaseAmountMinor: z.string().default(''),
});

const ENTITY_TYPES: EntityType[] = [
  'accounts',
  'categories',
  'tags',
  'transactions',
  'budgets',
  'budgetPeriods',
  'goals',
  'contributions',
  'recurringRules',
  'exchangeRates',
];

// `ENTITY_TYPES` is the list `hydrateFromStorage` walks, and it deliberately omits the
// settings singleton because that one is read and seeded separately. A merge has no such
// special case — an op can target `settings:settings` like any other row.
const ALL_ENTITY_TYPES: EntityType[] = ['settings', ...ENTITY_TYPES];

type ListKey = Exclude<EntityType, 'settings'>;

export class LocalFinanceRepository implements FinanceRepository {
  private state = createInitialState();
  private listeners = new Set<() => void>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private mutationActive = false;
  private pendingExternalRefresh = false;
  private deletedOccurrenceKeys = new Set<string>();

  constructor(private storage: StorageAdapter = new PlatformStorageAdapter()) {
    this.storage.subscribe?.((source) => {
      if (source === this || !this.state.ready) return;
      if (this.mutationActive) {
        // A refresh cannot run while a mutation holds the queue, but dropping it
        // left this window permanently stale: later local writes rebuild from the
        // stale snapshot, so nothing self-healed until the tab regained focus.
        // Remember it instead and drain once the queue settles.
        this.pendingExternalRefresh = true;
        return;
      }
      // Mirror `drainExternalRefresh`: a failed reload must not be dropped, or the
      // tab keeps rendering a snapshot it already knows is out of date. Re-arm so
      // the next settled mutation retries.
      this.refresh().catch(() => {
        this.pendingExternalRefresh = true;
      });
    });
  }

  initialize() {
    return this.enqueueMutation(() => this.initializeNow());
  }

  private async initializeNow() {
    await this.storage.initialize();
    await this.hydrateFromStorage();
    await this.migrateLoadedState();
    // No placeholder settings row is written here, and that is load-bearing for sync.
    //
    // `baseCurrency` is `createOnly` in the merge registry — deliberately, because rebasing
    // every snapshotted `baseAmountMinor` is not something a merge can do. So whatever value
    // the settings entity's *create* op carries is the value every peer materializes, forever.
    // Seeding a row before onboarding meant that op carried the app default, onboarding's real
    // choice arrived as a `set` the diff correctly dropped, and a vault set up in ILS shipped a
    // log that said USD. `records` and the op log disagreed permanently, and the disagreement
    // resolved in favour of the log the first time anything re-projected.
    //
    // Deferring the first write to `completeOnboarding` makes that write the create, so the op
    // log states the real base currency from the start. An un-onboarded store rehydrates to
    // exactly `createInitialState()`, so nothing else depends on the row being there early.
    await this.generateRecurringNow(addRecurrence(todayLocal(), 'month', 1));
    // Only now is the snapshot complete enough for screens to render against.
    this.state = { ...this.state, ready: true };
    this.emit();
  }

  refresh() {
    return this.enqueueMutation(async () => {
      await this.hydrateFromStorage();
      this.emit();
    });
  }

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Folds a batch of ops from another device into local state.
   *
   * Routed through the mutation queue rather than written straight to storage, and that is
   * not tidiness — it closes a lost-update window. Every local save hands `putMany` a *whole
   * entity* built from `this.state`, not a patch. If a merge committed between a save
   * reading `this.state` and its `await storage.putMany(...)`, the save would write back its
   * pre-merge view and silently revert the remote change on every field the two disagree
   * about. Serialising remote applies through the same queue removes the interleaving.
   *
   * The batch applies whole or not at all: the merged set is repaired and checked before
   * anything is written, and a failure leaves both `records` and the causal state untouched.
   */
  applyRemoteOps(ops: readonly SyncOpBody[]) {
    return this.enqueueMutation(async () => {
      // An op naming an entity type this version does not know comes from a newer app. The
      // sync engine still stores and forwards it — dropping it would break the hash chain for
      // every peer downstream — but there is nothing here to project it onto.
      const known = ops.filter((op) => isEntityType(op.entityType));
      if (!known.length) return { applied: 0, changedTypes: [], repairs: [] };
      const { repairs } = await this.projectNow(known);
      return { applied: known.length, changedTypes: changedTypes(known), repairs };
    });
  }

  applyRemoteState(states: readonly CausalMeta[]) {
    return this.enqueueMutation(async () => {
      const { writtenTypes, repairs } = await this.projectNow([], new Map(
        states.map((state) => [metaKey(state.entityType, state.entityId), state]),
      ));
      return { applied: states.length, changedTypes: writtenTypes, repairs };
    });
  }

  /**
   * Re-runs the repair sweep over the stored op log without applying anything new.
   *
   * See the contract in `repository.ts` for why this exists at all: a *local* edit can remove
   * the reason a repair was firing, and nothing else on this device would ever notice.
   */
  repairProjection() {
    return this.enqueueMutation(async () => {
      const { writtenTypes, repairs } = await this.projectNow([]);
      return { applied: 0, changedTypes: writtenTypes, repairs };
    });
  }

  private async projectNow(
    known: readonly SyncOpBody[],
    remoteStates?: ReadonlyMap<string, CausalMeta>,
  ) {
    // One transaction, and every read inside it. `transact`, deliberately, not `putMany`:
    // once `SyncingStorageAdapter` is installed, `putMany` is the change-capturing path and
    // would diff this merged result against the rows it replaces, emitting *local* ops that
    // attribute a peer's change to this device — which then replicate back as though this
    // device had made them. `transact` is the pass-through, and this is one of the callers
    // it exists for. `this` as the source so the adapter's own notification is filtered out
    // and the hydrate below is the only one; another tab sees a foreign write and takes the
    // existing `pendingExternalRefresh` path.
    const { written, writtenTypes, repairs } = await this.storage.transact(
      async (tx) => {
        // `sync_state` is the authority for causal state, re-read per pass rather than cached
        // in a field. A *local* write advances it through `SyncingStorageAdapter`, which this
        // object never observes, so a cached copy goes stale for precisely the fields both
        // devices touched — and a register missing from a stale copy has no HLC to lose to,
        // silently handing an older remote op the win over a newer local edit.
        const keys = remoteStates
          ? [...remoteStates.keys()]
          : [...new Set(known.map((op) => metaKey(op.entityType, op.entityId)))];
        const localStates = await readAllStates(tx);
        const merged = remoteStates
          ? mergeMetaMaps(localStates, remoteStates)
          : applyOps(localStates, known);

        // Read through storage rather than `this.state`: the snapshot drops tombstones, and
        // the repair pass has to see them. Resurrecting an account that a merged-in
        // transaction references is impossible if the deleted row is invisible.
        const original = new Map<string, FinanceEntity>();
        const tables = new Map<EntityType, Map<string, FinanceEntity>>();
        for (const type of ALL_ENTITY_TYPES) {
          const table = new Map<string, FinanceEntity>();
          for (const entity of await tx.readAll(type)) {
            table.set(entity.id, entity);
            original.set(metaKey(type, entity.id), entity);
          }
          tables.set(type, table);
        }

        // Every entity, not just the ones this batch names — and that is the whole reason the
        // full causal state is read above. The repair pass writes its corrections into
        // `records`, so feeding it `records` back would feed it its own output: an account
        // resurrected last week reads as live, the pass sees nothing to fix, and it stays live
        // forever even after the transaction that needed it is gone. Re-projecting from the op
        // log every pass is what makes a repair a *view* of the merged history rather than an
        // edit to it — recomputed from scratch, and therefore able to un-apply.
        for (const meta of merged.values()) {
          const table = tables.get(meta.entityType);
          if (!table) continue;
          // `materialize` returns null until the entity's `create` op has landed. A set that
          // arrives before its create is held rather than projected into a half-formed row.
          const next = materialize(meta, table.get(meta.entityId) ?? null);
          if (next) table.set(meta.entityId, next);
        }

        const list = <T extends FinanceEntity>(type: EntityType) =>
          [...tables.get(type)!.values()] as T[];
        const repaired = repairMergedState({
          settings: (tables.get('settings')!.get('settings') as AppSettings | undefined) ?? null,
          accounts: list<Account>('accounts'),
          categories: list<Category>('categories'),
          tags: list<Tag>('tags'),
          transactions: list<TransactionRecord>('transactions'),
          budgets: list<Budget>('budgets'),
          budgetPeriods: list<BudgetPeriodSnapshot>('budgetPeriods'),
          goals: list<Goal>('goals'),
          contributions: list<GoalContribution>('contributions'),
          recurringRules: list<RecurringRule>('recurringRules'),
          exchangeRates: list<ExchangeRate>('exchangeRates'),
        });
        this.assertMergedSetSafe(repaired);

        const records: StoredEntity[] = [];
        const touched = new Set<EntityType>();
        const push = (type: EntityType, entities: readonly FinanceEntity[]) => {
          for (const entity of entities) {
            // `finalize` settles `revision` against what is actually stored, and reports the
            // record unchanged when only the derived fields moved — so an op that re-states
            // a value this device already holds writes nothing and bumps nothing.
            const { entity: settled, changed } = finalize(
              entity,
              original.get(metaKey(type, entity.id)) ?? null,
            );
            if (!changed) continue;
            records.push({ type, entity: settled });
            touched.add(type);
          }
        };
        push('settings', repaired.settings ? [repaired.settings] : []);
        push('accounts', repaired.accounts);
        push('categories', repaired.categories);
        push('tags', repaired.tags);
        push('transactions', repaired.transactions);
        push('budgets', repaired.budgets);
        push('budgetPeriods', repaired.budgetPeriods);
        push('goals', repaired.goals);
        push('contributions', repaired.contributions);
        push('recurringRules', repaired.recurringRules);
        push('exchangeRates', repaired.exchangeRates);

        if (records.length) await tx.putMany(records);
        // Unconditional, and in the same transaction as the records. A record written
        // without its causal state would be re-derived from a merge that has already moved
        // on; a causal state written without its record would leave the projection behind a
        // merge this device has already agreed to. And a batch that changes no record still
        // advances the state — that is what makes redelivery a no-op rather than a re-merge.
        await writeStates(
          tx,
          remoteStates ? [...merged.values()] : keys.map((key) => merged.get(key)!),
        );
        return {
          written: records.length,
          writtenTypes: [...touched],
          repairs: repaired.notes,
        };
      },
      { source: this },
    );

    if (written) {
      await this.hydrateFromStorage();
      this.emit();
    }
    return { written, writtenTypes, repairs };
  }

  completeOnboarding(input: OnboardingInput) {
    return this.enqueueMutation(() => this.completeOnboardingNow(input));
  }

  private async completeOnboardingNow(input: OnboardingInput) {
    if (
      this.state.settings.onboardingComplete ||
      ENTITY_TYPES.some((type) => (this.state[type] as FinanceEntity[]).length > 0)
    ) throw new Error('Qashy setup is already complete.');
    this.assertLocale(input.locale);
    const baseCurrency = this.normalizeCurrency(input.baseCurrency);
    this.assertSafeMinor(input.openingBalanceMinor, 'Opening balance');
    this.assertColor(input.accentHex);
    if (!ACCOUNT_TYPES.includes(input.accountType)) throw new Error('Choose a valid account type.');
    if (!THEME_MODES.includes(input.themeMode)) throw new Error('Choose a valid theme mode.');
    if (!ACCENT_SOURCES.includes(input.accentSource)) throw new Error('Choose a valid accent source.');
    const settings = updateEntity(this.state.settings, {
      onboardingComplete: true,
      locale: input.locale,
      baseCurrency,
      themeMode: input.themeMode,
      accentSource: input.accentSource,
      accentHex: input.accentHex.toUpperCase(),
    });
    const account = createEntity({
      id: makeId(),
      name: input.accountName.trim() || defaultAccountName(input.locale),
      type: input.accountType,
      currency: baseCurrency,
      openingBalanceMinor: input.openingBalanceMinor,
      icon: 'wallet.bifold',
      color: input.accentHex.toUpperCase(),
      archived: false,
    });
    const categories = createDefaultCategories(input.locale);
    await this.storage.putMany([
      { type: 'settings', entity: settings },
      { type: 'accounts', entity: account },
      ...categories.map((entity) => ({ type: 'categories' as const, entity })),
    ], this);
    this.state = { ...this.state, settings, accounts: [account], categories };
    this.emit();
  }

  updateSettings(patch: SettingsInput, expectedRevision?: number) {
    return this.enqueueMutation(() => this.updateSettingsNow(patch, expectedRevision));
  }

  private async updateSettingsNow(patch: SettingsInput, expectedRevision?: number) {
    this.assertExpectedRevision(this.state.settings, patch, expectedRevision);
    const locale = patch.locale ?? this.state.settings.locale;
    const baseCurrency = this.normalizeCurrency(patch.baseCurrency ?? this.state.settings.baseCurrency);
    this.assertLocale(locale);
    this.assertColor(patch.accentHex ?? this.state.settings.accentHex);
    const themeMode = patch.themeMode ?? this.state.settings.themeMode;
    const accentSource = patch.accentSource ?? this.state.settings.accentSource;
    if (!THEME_MODES.includes(themeMode)) throw new Error('Choose a valid theme mode.');
    if (!ACCENT_SOURCES.includes(accentSource)) throw new Error('Choose a valid accent source.');
    if (baseCurrency !== this.state.settings.baseCurrency && this.state.settings.onboardingComplete) {
      throw new Error('Base currency cannot change after setup is complete.');
    }
    const settings = updateEntity(this.state.settings, {
      onboardingComplete: this.state.settings.onboardingComplete,
      locale,
      baseCurrency,
      themeMode,
      accentSource,
      accentHex: (patch.accentHex ?? this.state.settings.accentHex).toUpperCase(),
    });
    await this.persist('settings', [settings]);
    this.state = { ...this.state, settings };
    this.emit();
    return settings;
  }

  saveAccount(input: AccountInput, id?: string, expectedRevision?: number) {
    return this.enqueueMutation(() => this.saveAccountNow(input, id, expectedRevision));
  }

  private async saveAccountNow(input: AccountInput, id?: string, expectedRevision?: number) {
    const currency = this.normalizeCurrency(input.currency);
    this.assertSafeMinor(input.openingBalanceMinor, 'Opening balance');
    this.assertColor(input.color);
    if (!ACCOUNT_TYPES.includes(input.type)) throw new Error('Choose a valid account type.');
    const name = input.name.trim() || 'Account';
    this.assertUniqueName('accounts', name, id);
    const existing = this.findExisting(this.state.accounts, id, 'account');
    this.assertExpectedRevision(existing, input, expectedRevision);
    if (existing && existing.currency !== currency) {
      const hasTransactions = this.state.transactions.some((item) =>
        item.accountId === existing.id || item.destinationAccountId === existing.id,
      );
      const hasRules = this.state.recurringRules.some((item) => item.template.accountId === existing.id);
      if (hasTransactions || hasRules) {
        throw new Error('Account currency cannot change after transactions or schedules reference it.');
      }
    }
    const account = existing
      ? updateEntity(existing, { ...input, name, currency, color: input.color.toUpperCase() })
      : createEntity({ id: makeId(), ...input, name, currency, color: input.color.toUpperCase() }) as Account;
    const accounts = this.withEntity(this.state.accounts, account);
    this.assertTransactionSetSafe(this.state.transactions, accounts);
    const rules = input.archived
      ? this.state.recurringRules
        .filter((rule) => rule.active && rule.template.accountId === account.id)
        .map((rule) => updateEntity(rule, { active: false, pausedByDependency: true }))
      : existing?.archived
        ? this.state.recurringRules
          .filter((rule) =>
            !rule.active &&
            rule.pausedByDependency &&
            rule.template.accountId === account.id &&
            canActivateRecurringRule(rule, accounts, this.state.categories),
          )
          .map((rule) => updateEntity(rule, { active: true, pausedByDependency: false }))
        : [];
    await this.storage.putMany([
      { type: 'accounts', entity: account },
      ...rules.map((entity) => ({ type: 'recurringRules' as const, entity })),
    ], this);
    this.replaceInList('accounts', account);
    rules.forEach((rule) => this.replaceInList('recurringRules', rule));
    this.emit();
    if (rules.some((rule) => rule.active)) {
      await this.generateRecurringNow(addRecurrence(todayLocal(), 'month', 1));
    }
    return account;
  }

  saveCategory(input: CategoryInput, id?: string, expectedRevision?: number) {
    return this.enqueueMutation(() => this.saveCategoryNow(input, id, expectedRevision));
  }

  private async saveCategoryNow(input: CategoryInput, id?: string, expectedRevision?: number) {
    const name = input.name.trim() || 'Category';
    this.assertUniqueName('categories', name, id);
    this.assertColor(input.color);
    if (!CATEGORY_KINDS.includes(input.kind)) throw new Error('Choose a valid category kind.');
    const existing = this.findExisting(this.state.categories, id, 'category');
    this.assertExpectedRevision(existing, input, expectedRevision);
    if (existing && existing.kind !== input.kind) {
      const isReferenced = this.state.transactions.some((item) => item.categoryId === existing.id) ||
        this.state.recurringRules.some((item) => item.template.categoryId === existing.id) ||
        this.state.budgets.some((item) => item.filters.categoryIds.includes(existing.id)) ||
        this.state.goals.some((item) => item.linkedCategoryId === existing.id) ||
        this.state.categories.some((item) => item.parentId === existing.id);
      if (isReferenced) throw new Error('Category kind cannot change after finance records reference it.');
    }
    if (input.parentId) {
      const parent = this.state.categories.find((item) => item.id === input.parentId);
      const preservesArchivedParent = !!existing && existing.parentId === parent?.id;
      if (!parent || (!preservesArchivedParent && parent.archived) || parent.kind !== input.kind || parent.parentId || parent.id === id) {
        throw new Error('Choose a valid top-level parent category of the same kind.');
      }
      if (existing && this.state.categories.some((item) => item.parentId === existing.id)) {
        throw new Error('A category with child categories cannot also have a parent.');
      }
    }
    const values = {
      ...input,
      name,
      color: input.color.toUpperCase(),
    };
    const category = existing ? updateEntity(existing, values) : createEntity({ id: makeId(), ...values }) as Category;
    const categories = this.withEntity(this.state.categories, category);
    const rules = input.archived
      ? this.state.recurringRules
        .filter((rule) => rule.active && rule.template.categoryId === category.id)
        .map((rule) => updateEntity(rule, { active: false, pausedByDependency: true }))
      : existing?.archived
        ? this.state.recurringRules
          .filter((rule) =>
            !rule.active &&
            rule.pausedByDependency &&
            rule.template.categoryId === category.id &&
            canActivateRecurringRule(rule, this.state.accounts, categories),
          )
          .map((rule) => updateEntity(rule, { active: true, pausedByDependency: false }))
        : [];
    await this.storage.putMany([
      { type: 'categories', entity: category },
      ...rules.map((entity) => ({ type: 'recurringRules' as const, entity })),
    ], this);
    this.replaceInList('categories', category);
    rules.forEach((rule) => this.replaceInList('recurringRules', rule));
    this.emit();
    if (rules.some((rule) => rule.active)) {
      await this.generateRecurringNow(addRecurrence(todayLocal(), 'month', 1));
    }
    return category;
  }

  saveTag(input: TagInput, id?: string, expectedRevision?: number) {
    return this.enqueueMutation(() => this.saveTagNow(input, id, expectedRevision));
  }

  private async saveTagNow(input: TagInput, id?: string, expectedRevision?: number) {
    const name = input.name.trim();
    if (!name) throw new Error('Tag name is required.');
    this.assertUniqueName('tags', name, id);
    this.assertColor(input.color);
    return await this.saveListEntity<Tag>('tags', { ...input, name, color: input.color.toUpperCase() }, id, expectedRevision);
  }

  saveTransaction(input: TransactionInput, id?: string, expectedRevision?: number) {
    return this.enqueueMutation(() => this.saveTransactionNow(input, id, expectedRevision));
  }

  private async saveTransactionNow(input: TransactionInput, id?: string, expectedRevision?: number) {
    const transaction = this.buildTransaction(input, id, [], expectedRevision);
    this.assertTransactionSetSafe(this.withEntity(this.state.transactions, transaction));
    await this.persist('transactions', [transaction]);
    this.replaceInList('transactions', transaction);
    this.emit();
    return transaction;
  }

  saveBudget(input: BudgetInput, id?: string, expectedRevision?: number) {
    return this.enqueueMutation(() => this.saveBudgetNow(input, id, expectedRevision));
  }

  private async saveBudgetNow(input: BudgetInput, id?: string, expectedRevision?: number) {
    const normalized = this.validateBudget(input);
    const existing = this.findExisting(this.state.budgets, id, 'budget');
    this.assertExpectedRevision(existing, input, expectedRevision);
    const budget = existing
      ? updateEntity(existing, normalized)
      : createEntity({ id: makeId(), ...normalized }) as Budget;
    this.assertBudgetSetSafe(this.withEntity(this.state.budgets, budget));
    const periods = this.buildBudgetSnapshots(budget, true);
    periods.forEach((period) => {
      addMinor(period.limitMinor, period.rolloverMinor, `${budget.name} effective limit`);
    });
    await this.storage.putMany([
      { type: 'budgets', entity: budget },
      ...periods.map((entity) => ({ type: 'budgetPeriods' as const, entity })),
    ], this);
    this.replaceInList('budgets', budget);
    periods.forEach((period) => this.replaceInList('budgetPeriods', period));
    this.emit();
    return budget;
  }

  saveGoal(input: GoalInput, id?: string, expectedRevision?: number) {
    return this.enqueueMutation(() => this.saveGoalAndContributionNow(input, undefined, id, expectedRevision));
  }

  saveGoalAndContribution(
    input: GoalInput,
    contribution?: GoalContributionInput,
    id?: string,
    expectedRevision?: number,
  ) {
    return this.enqueueMutation(() => this.saveGoalAndContributionNow(input, contribution, id, expectedRevision));
  }

  private async saveGoalAndContributionNow(
    input: GoalInput,
    contribution?: GoalContributionInput,
    id?: string,
    expectedRevision?: number,
  ) {
    const normalized = this.validateGoal(input, id);
    const existing = this.findExisting(this.state.goals, id, 'goal');
    this.assertExpectedRevision(existing, input, expectedRevision);
    const goal = existing
      ? updateEntity(existing, normalized)
      : createEntity({ id: makeId(), ...normalized }) as Goal;
    let contributionEntity: GoalContribution | undefined;
    if (contribution) {
      this.assertPositiveMinor(contribution.amountMinor, 'Contribution');
      this.assertDate(contribution.localDate);
      if (
        contribution.transactionId &&
        !this.state.transactions.some((item) => item.id === contribution.transactionId)
      ) {
        throw new Error('Choose a valid transaction.');
      }
      contributionEntity = createEntity({
        id: makeId(),
        ...contribution,
        goalId: goal.id,
        note: contribution.note.trim(),
      }) as GoalContribution;
    }
    const goals = this.withEntity(this.state.goals, goal);
    const contributions = contributionEntity
      ? [...this.state.contributions, contributionEntity]
      : this.state.contributions;
    this.assertGoalProgressSafe(goal.id, goals, contributions);
    await this.storage.putMany([
      { type: 'goals', entity: goal },
      ...(contributionEntity
        ? [{ type: 'contributions' as const, entity: contributionEntity }]
        : []),
    ], this);
    // Re-derive from the post-await snapshot rather than reusing the `goals` /
    // `contributions` copies taken before the write. Another mutation can land
    // while the persist is in flight, and rebuilding from the stale copy drops
    // it from the in-memory state while it stays on disk — the UI then shows a
    // goal total that disagrees with the database until the next reload.
    this.state = {
      ...this.state,
      goals: this.withEntity(this.state.goals, goal),
      contributions: contributionEntity ? this.withEntity(this.state.contributions, contributionEntity) : this.state.contributions,
    };
    this.emit();
    return goal;
  }

  saveContribution(input: ContributionInput, id?: string, expectedRevision?: number) {
    return this.enqueueMutation(() => this.saveContributionNow(input, id, expectedRevision));
  }

  private async saveContributionNow(input: ContributionInput, id?: string, expectedRevision?: number) {
    this.assertPositiveMinor(input.amountMinor, 'Contribution');
    this.assertDate(input.localDate);
    if (!this.state.goals.some((item) => item.id === input.goalId)) throw new Error('Choose a valid goal.');
    if (input.transactionId && !this.state.transactions.some((item) => item.id === input.transactionId)) {
      throw new Error('Choose a valid transaction.');
    }
    const existing = this.findExisting(this.state.contributions, id, 'contribution');
    this.assertExpectedRevision(existing, input, expectedRevision);
    const contribution = existing
      ? updateEntity(existing, { ...input, note: input.note.trim() })
      : createEntity({ id: makeId(), ...input, note: input.note.trim() }) as GoalContribution;
    const contributions = this.withEntity(this.state.contributions, contribution);
    this.assertGoalProgressSafe(input.goalId, this.state.goals, contributions);
    await this.persist('contributions', [contribution]);
    this.replaceInList('contributions', contribution);
    this.emit();
    return contribution;
  }

  saveRecurringRule(input: RecurringInput, id?: string, expectedRevision?: number) {
    return this.enqueueMutation(() => this.saveRecurringRuleNow(input, id, expectedRevision));
  }

  private async saveRecurringRuleNow(input: RecurringInput, id?: string, expectedRevision?: number) {
    const existing = this.findExisting(this.state.recurringRules, id, 'recurring rule');
    this.assertExpectedRevision(existing, input, expectedRevision);
    const scheduleChanged = !!existing && (
      existing.unit !== input.unit ||
      existing.interval !== input.interval ||
      existing.startDate !== input.startDate ||
      existing.endDate !== input.endDate
    );
    const templateChanged = !!existing && (
      existing.template.kind !== input.template.kind ||
      existing.template.title !== input.template.title ||
      existing.template.note !== input.template.note ||
      existing.template.accountId !== input.template.accountId ||
      existing.template.categoryId !== input.template.categoryId ||
      existing.template.amountMinor !== input.template.amountMinor ||
      existing.template.currency !== input.template.currency ||
      JSON.stringify(existing.template.tagIds) !== JSON.stringify(input.template.tagIds)
    );
    const currentUpcoming = existing
      ? this.state.transactions.filter((transaction) =>
        transaction.recurringRuleId === existing.id && transaction.status === 'upcoming',
      )
      : [];
    const earliestUpcomingDate = currentUpcoming
      .map((transaction) => transaction.localDate)
      .sort()[0];
    const nextInput = scheduleChanged
      ? {
        ...input,
        nextDueDate: firstRecurrenceOnOrAfter(
          input.startDate,
          input.unit,
          input.interval,
          [input.startDate, earliestUpcomingDate ?? existing.nextDueDate, todayLocal()].sort().at(-1)!,
        ),
      }
      : input;
    const normalized = this.validateRecurring(nextInput, id);
    const pausedByDependency = Boolean(
      existing?.pausedByDependency && input.active && !normalized.active,
    );
    const rule = existing
      ? updateEntity(existing, { ...normalized, pausedByDependency })
      : createEntity({ id: makeId(), ...normalized, pausedByDependency: false }) as RecurringRule;
    const transactionChanges = scheduleChanged
      ? currentUpcoming.map((transaction) => updateEntity(transaction, {
        deletedAt: nowIso(),
        occurrenceKey: null,
      }))
      : templateChanged
        ? currentUpcoming.map((transaction) => this.buildTransaction({
          ...normalized.template,
          localDate: transaction.localDate,
          status: transaction.status,
          exchangeRate: transaction.accountId === normalized.template.accountId
            ? transaction.exchangeRate
            : undefined,
          recurringRuleId: rule.id,
          occurrenceKey: transaction.occurrenceKey,
        }, transaction.id))
        : [];
    const replacementsForValidation = new Map(transactionChanges.map((transaction) => [transaction.id, transaction]));
    const prospectiveTransactions = this.state.transactions
      .filter((transaction) => !replacementsForValidation.get(transaction.id)?.deletedAt)
      .map((transaction) => replacementsForValidation.get(transaction.id) ?? transaction);
    this.assertRecurringRuleGenerationSafe(
      rule,
      prospectiveTransactions,
      addRecurrence(todayLocal(), 'month', 1),
    );
    await this.storage.putMany([
      { type: 'recurringRules', entity: rule },
      ...transactionChanges.map((entity) => ({ type: 'transactions' as const, entity })),
    ], this);
    const replacements = new Map(
      transactionChanges
        .filter((transaction) => !transaction.deletedAt)
        .map((transaction) => [transaction.id, transaction]),
    );
    const removedIds = new Set(
      transactionChanges
        .filter((transaction) => transaction.deletedAt)
        .map((transaction) => transaction.id),
    );
    this.state = {
      ...this.state,
      recurringRules: this.withEntity(this.state.recurringRules, rule),
      transactions: this.state.transactions
        .filter((transaction) => !removedIds.has(transaction.id))
        .map((transaction) => replacements.get(transaction.id) ?? transaction),
    };
    this.emit();
    if (rule.active) await this.generateRecurringNow(addRecurrence(todayLocal(), 'month', 1));
    return rule;
  }

  saveExchangeRate(input: RateInput, id?: string, expectedRevision?: number) {
    return this.enqueueMutation(() => this.saveExchangeRateNow(input, id, expectedRevision));
  }

  private async saveExchangeRateNow(input: RateInput, id?: string, expectedRevision?: number) {
    const fromCurrency = this.normalizeCurrency(input.fromCurrency);
    const toCurrency = this.normalizeCurrency(input.toCurrency);
    if (fromCurrency === toCurrency) throw new Error('Exchange-rate currencies must be different.');
    this.assertDate(input.effectiveDate);
    const rate = this.normalizeRate(input.rate);
    const duplicate = this.state.exchangeRates.find((item) =>
      item.id !== id && item.fromCurrency === fromCurrency && item.toCurrency === toCurrency &&
      item.effectiveDate === input.effectiveDate,
    );
    if (duplicate) throw new Error('A rate already exists for this currency pair and date.');
    this.assertReciprocalRate(fromCurrency, toCurrency, rate, input.effectiveDate, id);
    const existing = this.findExisting(this.state.exchangeRates, id, 'exchange rate');
    this.assertExpectedRevision(existing, input, expectedRevision);
    const exchangeRate = existing ? updateEntity(existing, {
      ...input,
      fromCurrency,
      toCurrency,
      rate,
    }) : createEntity({
      id: makeId(),
      ...input,
      fromCurrency,
      toCurrency,
      rate,
    }) as ExchangeRate;
    const exchangeRates = this.withEntity(this.state.exchangeRates, exchangeRate);
    this.assertTransactionSetSafe(this.state.transactions, this.state.accounts, exchangeRates);
    await this.persist('exchangeRates', [exchangeRate]);
    this.replaceInList('exchangeRates', exchangeRate);
    this.emit();
    return exchangeRate;
  }

  queryTransactions(query: TransactionQuery = {}, snapshot = this.state.transactions) {
    const normalizedSearch = query.search?.trim().toLocaleLowerCase();
      const matchesCategory = query.categoryIds?.length ? this.categoryMatcher(query.categoryIds) : null;
      let result = this.active(snapshot).filter((transaction) => {
        if (normalizedSearch && !`${transaction.title} ${transaction.note}`.toLocaleLowerCase().includes(normalizedSearch)) return false;
        if (
          query.accountIds?.length &&
          !query.accountIds.includes(transaction.accountId) &&
          !(transaction.kind === 'transfer' && transaction.destinationAccountId && query.accountIds.includes(transaction.destinationAccountId))
        ) return false;
        // Hierarchy-aware, matching `budgetSpend` and goal progress. Selecting a
        // parent category used to return nothing for transactions filed under its
        // children, so the same category could read "spent 240.00" in a budget while
        // the transaction list filtered to it came back empty.
        if (matchesCategory && !matchesCategory(transaction.categoryId)) return false;
        if (query.tagIds?.length && !query.tagIds.some((id) => transaction.tagIds.includes(id))) return false;
        if (query.kinds?.length && !query.kinds.includes(transaction.kind)) return false;
        if (query.statuses?.length && !query.statuses.includes(transaction.status)) return false;
        if (query.fromDate && transaction.localDate < query.fromDate) return false;
        if (query.toDate && transaction.localDate > query.toDate) return false;
        if (query.minMinor !== undefined && transaction.baseAmountMinor < query.minMinor) return false;
        if (query.maxMinor !== undefined && transaction.baseAmountMinor > query.maxMinor) return false;
        return true;
      });
      if (query.sort !== false) {
        result = result.sort((a, b) => {
          if (query.sort === 'oldest') return a.localDate.localeCompare(b.localDate) || a.createdAt.localeCompare(b.createdAt);
          if (query.sort === 'amount-desc') return b.baseAmountMinor - a.baseAmountMinor;
          return b.localDate.localeCompare(a.localDate) || b.createdAt.localeCompare(a.createdAt);
        });
      }
      const offset = query.offset ?? 0;
      return result.slice(offset, query.limit ? offset + query.limit : undefined);
    }

  getDashboard(fromDate: string, toDate: string): DashboardSummary {
    this.assertDate(fromDate);
    this.assertDate(toDate);
    if (fromDate > toDate) throw new Error('Dashboard start date must not be after its end date.');
    if (this.daySpan(fromDate, toDate) > MAX_DASHBOARD_DAYS) {
      throw new Error('Choose a dashboard range no longer than a century.');
    }
    const posted = this.queryTransactions({ fromDate, toDate, statuses: ['posted'], sort: false });
    const allPosted = this.queryTransactions({ statuses: ['posted'], sort: false });
    const accounts = this.active(this.state.accounts);
    // One pass over every posted transaction keeps balances O(n + accounts)
    // instead of O(accounts × n); a running total does not need the sort.
    const balances = new Map(accounts.map((account) => [account.id, account.openingBalanceMinor]));
    for (const transaction of allPosted) {
      if (transaction.kind === 'expense' || transaction.kind === 'transfer') {
        const current = balances.get(transaction.accountId);
        if (current !== undefined) balances.set(transaction.accountId, subtractMinor(current, transaction.amountMinor, 'Account balance'));
      }
      if (transaction.kind === 'income') {
        const current = balances.get(transaction.accountId);
        if (current !== undefined) balances.set(transaction.accountId, addMinor(current, transaction.amountMinor, 'Account balance'));
      }
      if (transaction.kind === 'transfer' && transaction.destinationAccountId) {
        const current = balances.get(transaction.destinationAccountId);
        if (current !== undefined) balances.set(transaction.destinationAccountId, addMinor(current, transaction.destinationAmountMinor ?? 0, 'Account balance'));
      }
    }
    const accountBalances = accounts
      .map((account) => ({ account, balanceMinor: balances.get(account.id) ?? account.openingBalanceMinor }))
      // An archived account still holds real money. Dropping it here removed its
      // balance from net worth while its transactions kept counting toward the
      // income and expense totals, so the summary contradicted itself: deleting
      // a referenced account (which archives it) zeroed net worth and left no
      // account on screen to explain where the money went. Hide an archived
      // account only once it is actually empty.
      .filter(({ account, balanceMinor }) => !account.archived || balanceMinor !== 0);
    const expenseCategories = this.active(this.state.categories)
      .filter((category) => category.kind === 'expense');
    const expenseCategoryIds = new Set(expenseCategories.map((category) => category.id));
    // One pass over the range for income, expense, category, uncategorized, and
        // daily totals, tracking the 5 newest rows for recentTransactions so the
        // whole range never needs sorting.
        let incomeMinor = 0;
        let expenseMinor = 0;
        const categoryTotals = new Map<string, number>();
        const dayTotals = new Map<string, number>();
        const recentTransactions: TransactionRecord[] = [];
        let uncategorizedMinor = 0;
        for (const item of posted) {
          if (item.kind === 'income') {
            incomeMinor = addMinor(incomeMinor, item.baseAmountMinor, 'Income total');
          } else if (item.kind === 'expense') {
            expenseMinor = addMinor(expenseMinor, item.baseAmountMinor, 'Expense total');
            dayTotals.set(item.localDate, addMinor(dayTotals.get(item.localDate) ?? 0, item.baseAmountMinor, 'Daily spending'));
            if (item.categoryId && expenseCategoryIds.has(item.categoryId)) {
              categoryTotals.set(item.categoryId, addMinor(categoryTotals.get(item.categoryId) ?? 0, item.baseAmountMinor, 'Category spending'));
            } else {
              uncategorizedMinor = addMinor(uncategorizedMinor, item.baseAmountMinor, 'Uncategorized spending');
            }
          }
          const insertAt = recentTransactions.findIndex((existing) =>
            item.localDate > existing.localDate ||
            (item.localDate === existing.localDate && item.createdAt > existing.createdAt));
          if (insertAt === -1) {
            if (recentTransactions.length < 5) recentTransactions.push(item);
          } else {
            recentTransactions.splice(insertAt, 0, item);
            if (recentTransactions.length > 5) recentTransactions.pop();
          }
        }
    const categorySpend: DashboardSummary['categorySpend'] = expenseCategories
      .map((category) => ({ category, amountMinor: categoryTotals.get(category.id) ?? 0 }))
      .filter((item) => item.amountMinor > 0);
    if (uncategorizedMinor > 0) {
      categorySpend.push({ category: null, amountMinor: uncategorizedMinor });
    }
    categorySpend.sort((a, b) => b.amountMinor - a.amountMinor);
    const today = todayLocal();
    const budgetDate = today >= fromDate && today <= toDate ? today : toDate;
    const budgetEntries = this.getBudgetStatuses(budgetDate, { includeInactiveCustom: true })
      .filter(({ budget, snapshot }) =>
        budget.period.unit !== 'custom' ||
        (snapshot.periodStart <= toDate && snapshot.periodEnd >= fromDate),
      );
    const budgetLimitMinor = sumMinor(
      budgetEntries.map((entry) => entry.effectiveLimitMinor),
      'Budget limit total',
    );
    const budgetSpentMinor = sumMinor(
      budgetEntries.map((entry) => entry.spentMinor),
      'Budget spending total',
    );
    const dailySpend: DashboardSummary['dailySpend'] = [];
    let spendDate = fromDate;
    let spendGuard = 0;
    while (spendDate <= toDate && spendGuard < MAX_DASHBOARD_DAYS) {
      dailySpend.push({ date: spendDate, amountMinor: dayTotals.get(spendDate) ?? 0 });
      spendDate = addRecurrence(spendDate, 'day', 1);
      spendGuard += 1;
    }
    let netWorthMinor = 0;
    const missingExchangeRates: DashboardSummary['missingExchangeRates'] = [];
    const balanceDate = todayLocal();
    for (const item of accountBalances) {
      let rate: string;
      try {
        rate = this.resolveRate(
          item.account.currency,
          this.state.settings.baseCurrency,
          balanceDate,
        );
      } catch {
        if (!missingExchangeRates.some((rate) => rate.fromCurrency === item.account.currency)) {
          missingExchangeRates.push({
            fromCurrency: item.account.currency,
            toCurrency: this.state.settings.baseCurrency,
          });
        }
        continue;
      }
      netWorthMinor = addMinor(
        netWorthMinor,
        convertMinor(
          item.balanceMinor,
          item.account.currency,
          this.state.settings.baseCurrency,
          rate,
          this.state.settings.locale,
        ),
        'Net worth',
      );
    }
    return {
      netWorthMinor,
      incomeMinor,
      expenseMinor,
      netFlowMinor: subtractMinor(incomeMinor, expenseMinor, 'Net flow'),
      budgetLimitMinor,
      budgetSpentMinor,
      accountBalances,
      categorySpend,
      recentTransactions,
      upcomingTransactions: this.queryTransactions({ statuses: ['upcoming'], sort: 'oldest', limit: 5 }),
      dailySpend,
      missingExchangeRates,
    };
  }

  getBudgetStatuses(
    onDate: string,
    options: { includeInactiveCustom?: boolean } = {},
  ): BudgetStatus[] {
    this.assertDate(onDate);
    return this.active(this.state.budgets)
      .filter((budget) => !budget.archived)
      .flatMap((budget) => {
        const bounds = resolvePeriod(budget.period, onDate);
        if (
          budget.period.unit === 'custom' &&
          !options.includeInactiveCustom &&
          (onDate < bounds.start || onDate > bounds.end)
        ) return [];
        // Fall back to a transient snapshot when the period rolled over while
        // the app stayed open; the next generateRecurring run persists it.
        const snapshot = this.state.budgetPeriods.find((item) =>
          item.budgetId === budget.id && item.periodStart === bounds.start,
        ) ?? this.buildBudgetSnapshots(budget, false, onDate, true).find((item) => item.periodStart === bounds.start);
        if (!snapshot) return [];
        const spentMinor = this.budgetSpend(snapshot.filters, snapshot.periodStart, snapshot.periodEnd);
        const categorySpend = snapshot.categoryLimits.map((limit) => ({
          ...limit,
          amountMinor: this.budgetSpend(
            { ...snapshot.filters, categoryIds: [limit.categoryId] },
            snapshot.periodStart,
            snapshot.periodEnd,
          ),
        }));
        return [{
          budget,
          snapshot,
          spentMinor,
          effectiveLimitMinor: addMinor(
            snapshot.limitMinor,
            snapshot.rolloverMinor,
            `${budget.name} effective limit`,
          ),
          categorySpend,
        }];
      });
  }

  getGoalProgress(goalId: string) {
    return this.calculateGoalProgress(
      goalId,
      this.state.goals,
      this.state.contributions,
      this.state.transactions,
    );
  }

  // The base value credited by a transfer's destination leg. baseAmountMinor
  // snapshots the source leg, which diverges from the destination whenever the
  // manual destination amount disagrees with the source-leg conversion.
  private transferInflowBaseMinor(item: TransactionRecord) {
    return item.destinationBaseAmountMinor ?? item.baseAmountMinor;
  }

  generateRecurring(horizonDate = addRecurrence(todayLocal(), 'month', 1)) {
    return this.enqueueMutation(() => this.generateRecurringNow(horizonDate));
  }

  private async generateRecurringNow(horizonDate: string) {
    this.assertDate(horizonDate);
    const today = todayLocal();
    let generated = 0;
    const transactions = [...this.state.transactions];
    const transactionChanges: TransactionRecord[] = [];
    const ruleChanges: RecurringRule[] = [];
    for (const rule of this.active(this.state.recurringRules).filter((item) => item.active)) {
      // A rule that can no longer build its transaction (dangling reference,
      // missing exchange rate) is skipped so one bad rule never blocks the
      // other rules or app startup, which awaits this generation.
      try {
        if (rule.autoPost) {
          transactions.forEach((transaction, index) => {
            if (
              transaction.recurringRuleId === rule.id &&
              transaction.status === 'upcoming' &&
              transaction.localDate <= today
            ) {
              const updated = updateEntity(transaction, { status: 'posted' });
              transactions[index] = updated;
              transactionChanges.push(updated);
            }
          });
        }
        let due = rule.nextDueDate;
        let guard = 0;
        while (due <= horizonDate && guard < MAX_RECURRING_OCCURRENCES_PER_RUN) {
          guard += 1;
          if (rule.endDate && due > rule.endDate) break;
          const occurrenceKey = `${rule.id}:${due}`;
          if (
            !this.deletedOccurrenceKeys.has(occurrenceKey) &&
            !transactions.some((item) => item.occurrenceKey === occurrenceKey)
          ) {
            const transaction = this.buildTransaction({
              ...rule.template,
              localDate: due,
              status: rule.autoPost && due <= today ? 'posted' : 'upcoming',
              recurringRuleId: rule.id,
              occurrenceKey,
            });
            transactions.push(transaction);
            transactionChanges.push(transaction);
            generated += 1;
          }
          const nextDue = addRecurrence(due, rule.unit, Math.max(1, rule.interval), rule.startDate);
          if (nextDue <= due) throw new Error('Recurring schedule did not advance.');
          due = nextDue;
        }
        if (guard >= MAX_RECURRING_OCCURRENCES_PER_RUN && due <= horizonDate) {
          throw new Error('Recurring schedule has too many occurrences to generate in one run.');
        }
        const active = !rule.endDate || due <= rule.endDate;
        if (due !== rule.nextDueDate || active !== rule.active) {
          ruleChanges.push(updateEntity(rule, { nextDueDate: due, active }));
        }
      } catch {
        // Generation for this rule failed — most often a missing exchange rate
        // for its currency pair. Swallowing it silently left `nextDueDate`
        // frozen forever with no error, no flag, and nothing for the user to
        // act on. Pause the rule instead so it surfaces as "Paused" in the
        // Automation list and the user can fix the cause and re-enable it.
        if (rule.active) ruleChanges.push(updateEntity(rule, { active: false, pausedByDependency: false }));
        continue;
      }
    }
    const recurringChanged = transactionChanges.length > 0 || ruleChanges.length > 0;
    if (recurringChanged) {
      this.assertTransactionSetSafe(transactions);
      await this.storage.putMany([
        ...transactionChanges.map((entity) => ({ type: 'transactions' as const, entity })),
        ...ruleChanges.map((entity) => ({ type: 'recurringRules' as const, entity })),
      ], this);
      // Merge into the current state rather than replacing it with the
      // pre-await snapshot, so transactions saved while putMany was in
      // flight are not dropped.
      const changedTransactions = new Map(transactionChanges.map((item) => [item.id, item]));
      const changedRules = new Map(ruleChanges.map((rule) => [rule.id, rule]));
      const currentIds = new Set(this.state.transactions.map((item) => item.id));
      this.state = {
        ...this.state,
        transactions: [
          ...this.state.transactions.map((item) => changedTransactions.get(item.id) ?? item),
          ...transactionChanges.filter((item) => !currentIds.has(item.id)),
        ],
        recurringRules: this.state.recurringRules.map((rule) => changedRules.get(rule.id) ?? rule),
      };
    }
    const budgetChanges = await this.ensureBudgetSnapshots();
    if (recurringChanged || budgetChanges) this.emit();
    return generated;
  }

  confirmUpcoming(id: string) {
    return this.enqueueMutation(() => this.confirmUpcomingNow(id));
  }

  private async confirmUpcomingNow(id: string) {
    const transaction = this.state.transactions.find((item) => item.id === id);
    if (!transaction || transaction.status !== 'upcoming') return;
    const updated = updateEntity(transaction, { status: 'posted' });
    this.assertTransactionSetSafe(this.withEntity(this.state.transactions, updated));
    await this.persist('transactions', [updated]);
    this.replaceInList('transactions', updated);
    this.emit();
  }

  skipUpcoming(id: string) {
    return this.enqueueMutation(() => this.skipUpcomingNow(id));
  }

  private async skipUpcomingNow(id: string) {
    const transaction = this.state.transactions.find((item) => item.id === id);
    if (!transaction || transaction.status !== 'upcoming') return;
    const updated = updateEntity(transaction, { status: 'skipped' });
    await this.persist('transactions', [updated]);
    this.replaceInList('transactions', updated);
    this.emit();
  }

  updateTransactionsCategory(ids: string[], categoryId: string | null) {
    return this.enqueueMutation(() => this.updateTransactionsCategoryNow(ids, categoryId));
  }

  private async updateTransactionsCategoryNow(ids: string[], categoryId: string | null) {
    const selected = new Set(ids);
    const candidates = this.state.transactions.filter((item) => selected.has(item.id));
    if (candidates.some((item) => item.kind === 'transfer')) {
      throw new Error('Transfers do not have categories.');
    }
    if (categoryId) {
      const category = this.state.categories.find((item) => item.id === categoryId && !item.archived);
      if (!category) throw new Error('Choose a valid category.');
      if (candidates.some((item) => item.kind !== category.kind)) {
        throw new Error(`The ${category.name} category can only be assigned to ${category.kind} transactions.`);
      }
    }
    const updated = candidates.map((item) => updateEntity(item, { categoryId }));
    const replacements = new Map(updated.map((item) => [item.id, item]));
    const transactions = this.state.transactions.map((item) => replacements.get(item.id) ?? item);
    this.assertTransactionSetSafe(transactions);
    await this.persist('transactions', updated);
    this.state = {
      ...this.state,
      transactions,
    };
    this.emit();
  }

  deleteEntities(type: keyof FinanceState, ids: string[]) {
    return this.enqueueMutation(() => this.deleteEntitiesNow(type, ids));
  }

  private async deleteEntitiesNow(type: keyof FinanceState, ids: string[]) {
    if (type === 'ready' || type === 'settings') return;
    const list = this.state[type] as FinanceEntity[];
    let deletedIds = new Set(ids);
    let deleted = list.filter((entity) => deletedIds.has(entity.id)).map((entity) => updateEntity(entity, { deletedAt: nowIso() }));
    let archivedAccounts: Account[] = [];
    let pausedRules: RecurringRule[] = [];

    // Accounts are part of every ledger entry's identity and cannot be nulled
    // or reassigned without changing history. Convert deletion of a referenced
    // account into the same safe archive operation exposed by the UI.
    if (type === 'accounts') {
      const referencedIds = new Set(this.state.accounts.filter((account) =>
        this.state.transactions.some((item) =>
          item.accountId === account.id || item.destinationAccountId === account.id) ||
        this.state.recurringRules.some((item) => item.template.accountId === account.id) ||
        this.state.budgets.some((item) => item.filters.accountIds.includes(account.id)) ||
        this.state.goals.some((item) => item.linkedAccountId === account.id),
      ).map((account) => account.id));
      const archiveIds = new Set(ids.filter((id) => referencedIds.has(id)));
      if (archiveIds.size) {
        // A mixed batch may contain both a referenced and an unused account. Archive only the
        // former; the latter still receives the user-requested soft deletion in this same write.
        deletedIds = new Set(ids.filter((id) => !archiveIds.has(id)));
        deleted = list.filter((entity) => deletedIds.has(entity.id)).map((entity) => updateEntity(entity, { deletedAt: nowIso() }));
        archivedAccounts = this.state.accounts
          .filter((account) => archiveIds.has(account.id))
          .map((account) => updateEntity(account, { archived: true }));
        pausedRules = this.state.recurringRules
          .filter((rule) => rule.active && archiveIds.has(rule.template.accountId))
          .map((rule) => updateEntity(rule, { active: false, pausedByDependency: true }));
      }
    }

    const ruleChanges = this.state.recurringRules.flatMap((rule) => {
      if (type === 'categories' && rule.template.categoryId && deletedIds.has(rule.template.categoryId)) {
        const template = { ...rule.template, categoryId: null };
        // Dropping the category removes one blocker, not necessarily every one:
        // clearing `pausedByDependency` unconditionally used to strand a rule whose
        // account is still archived, because both reactivation gates key off that
        // flag. Only a rule that is paused *and* now has all of its dependencies
        // satisfied may come back; a user-paused rule is left exactly as it is.
        if (!rule.active && rule.pausedByDependency) {
          const candidate = { ...rule, template };
          const restored = canActivateRecurringRule(candidate, this.state.accounts, this.state.categories);
          return [updateEntity(rule, {
            template,
            active: restored,
            pausedByDependency: !restored,
          })];
        }
        return [updateEntity(rule, { template })];
      }
      if (type === 'tags' && rule.template.tagIds.some((id) => deletedIds.has(id))) {
        return [updateEntity(rule, {
          template: { ...rule.template, tagIds: rule.template.tagIds.filter((id) => !deletedIds.has(id)) },
        })];
      }
      return [];
    });
    const reactivatedRule = ruleChanges.some((rule) =>
      rule.active && this.state.recurringRules.some((item) => item.id === rule.id && !item.active),
    );
    const contributions = type === 'goals'
      ? this.state.contributions
        .filter((item) => deletedIds.has(item.goalId))
        .map((item) => updateEntity(item, { deletedAt: nowIso() }))
      : [];
    const budgetPeriods = type === 'budgets'
      ? this.state.budgetPeriods
        .filter((item) => deletedIds.has(item.budgetId))
        .map((item) => updateEntity(item, { deletedAt: nowIso() }))
      : [];
    const orphanedContributions = type === 'transactions'
      ? this.state.contributions
        .filter((item) => !item.deletedAt && item.transactionId !== null && deletedIds.has(item.transactionId))
        .map((item) => updateEntity(item, { deletedAt: nowIso() }))
      : [];
    const releasedTransactions = type === 'recurringRules'
      ? this.state.transactions
        .filter((item) => !item.deletedAt && item.recurringRuleId !== null && deletedIds.has(item.recurringRuleId))
        .map((item) => updateEntity(item, { recurringRuleId: null }))
      : [];
    const untaggedTransactions = type === 'tags'
      ? this.state.transactions
        .filter((item) => !item.deletedAt && item.tagIds.some((tagId) => deletedIds.has(tagId)))
        .map((item) => updateEntity(item, { tagIds: item.tagIds.filter((tagId) => !deletedIds.has(tagId)) }))
      : [];
    const uncategorisedTransactions = type === 'categories'
      ? this.state.transactions
        .filter((item) => !item.deletedAt && item.categoryId !== null && deletedIds.has(item.categoryId))
        .map((item) => updateEntity(item, { categoryId: null }))
      : [];
    const detachedCategories = type === 'categories'
      ? this.state.categories
        .filter((item) => item.parentId !== null && deletedIds.has(item.parentId) && !deletedIds.has(item.id))
        .map((item) => updateEntity(item, { parentId: null }))
      : [];
    const budgetChanges = type === 'categories' || type === 'tags'
      ? this.state.budgets.flatMap((budget) => {
        const filters = type === 'categories'
          ? { ...budget.filters, categoryIds: budget.filters.categoryIds.filter((id) => !deletedIds.has(id)) }
          : { ...budget.filters, tagIds: budget.filters.tagIds.filter((id) => !deletedIds.has(id)) };
        const categoryLimits = type === 'categories'
          ? budget.categoryLimits.filter((limit) => !deletedIds.has(limit.categoryId))
          : budget.categoryLimits;
        if (
          filters.categoryIds.length === budget.filters.categoryIds.length &&
          filters.tagIds.length === budget.filters.tagIds.length &&
          categoryLimits.length === budget.categoryLimits.length
        ) return [];
        return [updateEntity(budget, { filters, categoryLimits })];
      })
      : [];
    const goalChanges = type === 'categories'
      ? this.state.goals
        .filter((goal) => goal.linkedCategoryId !== null && deletedIds.has(goal.linkedCategoryId))
        .map((goal) => updateEntity(goal, { linkedCategoryId: null }))
      : [];
    const transactionChanges = [...releasedTransactions, ...untaggedTransactions, ...uncategorisedTransactions];
    if (type === 'transactions') {
      this.assertTransactionSetSafe(
        this.state.transactions.filter((item) => !deletedIds.has(item.id)),
      );
    }
    await this.storage.putMany([
      ...deleted.map((entity) => ({ type: type as EntityType, entity })),
      ...archivedAccounts.map((entity) => ({ type: 'accounts' as const, entity })),
      ...ruleChanges.map((entity) => ({ type: 'recurringRules' as const, entity })),
      ...pausedRules.map((entity) => ({ type: 'recurringRules' as const, entity })),
      ...contributions.map((entity) => ({ type: 'contributions' as const, entity })),
      ...orphanedContributions.map((entity) => ({ type: 'contributions' as const, entity })),
      ...budgetPeriods.map((entity) => ({ type: 'budgetPeriods' as const, entity })),
      ...transactionChanges.map((entity) => ({ type: 'transactions' as const, entity })),
      ...detachedCategories.map((entity) => ({ type: 'categories' as const, entity })),
      ...budgetChanges.map((entity) => ({ type: 'budgets' as const, entity })),
      ...goalChanges.map((entity) => ({ type: 'goals' as const, entity })),
    ], this);
    if (type === 'transactions') {
      deleted.forEach((entity) => {
        const occurrenceKey = (entity as TransactionRecord).occurrenceKey;
        if (occurrenceKey) this.deletedOccurrenceKeys.add(occurrenceKey);
      });
    }
    const recurringReplacements = new Map([...ruleChanges, ...pausedRules].map((rule) => [rule.id, rule]));
    const nextState = {
      ...this.state,
      [type]: (this.state[type] as FinanceEntity[]).filter((entity) => !deletedIds.has(entity.id)),
    } as FinanceState;
    nextState.recurringRules = nextState.recurringRules.map((rule) => recurringReplacements.get(rule.id) ?? rule);
    if (archivedAccounts.length) {
      const replacements = new Map(archivedAccounts.map((account) => [account.id, account]));
      nextState.accounts = nextState.accounts.map((account) => replacements.get(account.id) ?? account);
    }
    if (transactionChanges.length) {
      const edits = new Map(transactionChanges.map((item) => [item.id, item]));
      nextState.transactions = nextState.transactions.map((item) => edits.get(item.id) ?? item);
    }
    if (orphanedContributions.length) {
      const retired = new Set(orphanedContributions.map((item) => item.id));
      nextState.contributions = nextState.contributions.filter((item) => !retired.has(item.id));
    }
    if (type === 'goals') {
      nextState.contributions = nextState.contributions.filter((item) => !deletedIds.has(item.goalId));
    }
    if (type === 'budgets') {
      nextState.budgetPeriods = nextState.budgetPeriods.filter((item) => !deletedIds.has(item.budgetId));
    }
    if (detachedCategories.length) {
      const replacements = new Map(detachedCategories.map((item) => [item.id, item]));
      nextState.categories = nextState.categories.map((item) => replacements.get(item.id) ?? item);
    }
    if (budgetChanges.length) {
      const replacements = new Map(budgetChanges.map((item) => [item.id, item]));
      nextState.budgets = nextState.budgets.map((item) => replacements.get(item.id) ?? item);
    }
    if (goalChanges.length) {
      const replacements = new Map(goalChanges.map((item) => [item.id, item]));
      nextState.goals = nextState.goals.map((item) => replacements.get(item.id) ?? item);
    }
    this.state = nextState;
    this.emit();
    // A rule that came back off dependency-pause has to catch up on the occurrences
    // it missed while paused, exactly as it does when the blocking account or
    // category is un-archived.
    if (reactivatedRule) {
      await this.generateRecurringNow(addRecurrence(todayLocal(), 'month', 1));
    }
  }

  mergeDuplicates(groups: readonly DuplicateGroup[]) {
    return this.enqueueMutation(() => this.mergeDuplicatesNow(groups));
  }

  /**
   * Collapses user-confirmed duplicate records into one, as ordinary entity writes.
   *
   * Pairing two vaults that both hold real data leaves two of everything the user created on
   * both devices. The repair pass renames those rather than merging them, because merging is a
   * judgement — so this is where the judgement, once made, is carried out.
   *
   * The whole operation is validated before a byte is written, and it is a single `putMany`.
   * That matters more here than almost anywhere else: a merge that half-applied would leave
   * transactions pointing at an account that was tombstoned in the same breath, and the repair
   * pass would resurrect it on every device as a live-but-archived ghost of the record the user
   * just told Qashy to get rid of.
   */
  private async mergeDuplicatesNow(groups: readonly DuplicateGroup[]) {
    const plan = planMerge(this.state, groups);
    if (!plan.records.length) return { merged: 0, retargeted: 0 };

    // Balances genuinely move when two accounts become one, so the money invariants are re-run
    // over the *projected* set rather than the current one — this is the check that catches a
    // merge whose combined opening balance and history overflow a safe integer.
    const projected = new Map(plan.records.map((record) => [`${record.type}:${record.entity.id}`, record.entity]));
    const project = <T extends FinanceEntity>(type: EntityType, rows: readonly T[]) =>
      rows
        .map((row) => (projected.get(`${type}:${row.id}`) as T | undefined) ?? row)
        .filter((row) => !row.deletedAt);
    this.assertTransactionSetSafe(
      project('transactions', this.state.transactions),
      project('accounts', this.state.accounts),
    );

    await this.storage.putMany([...plan.records], this);
    // Rehydrating rather than splicing the snapshot: a merge touches up to eight entity types
    // at once, and `deletedOccurrenceKeys` has to be rebuilt from the new tombstones so a rule
    // does not re-post the occurrence that just became the duplicate.
    await this.hydrateFromStorage();
    this.emit();
    return { merged: plan.removed, retargeted: plan.retargeted };
  }

  importCsv(rows: CsvImportRow[], commit = false) {
    return commit
      ? this.enqueueMutation(() => this.importCsvNow(rows, true))
      : this.importCsvNow(rows, false);
  }

  private async importCsvNow(rows: CsvImportRow[], commit = false) {
    const result: ImportResult = { validRows: [], rejectedRows: [], duplicateRows: [], warnings: [], committedIds: [] };
    const staged: { input: TransactionInput; tagNames: string[] }[] = [];
    const duplicateKeys = new Set(this.state.transactions.map((item) => this.transactionDuplicateKey(item)));
    for (const raw of rows) {
      const parsed = csvRowSchema.safeParse(raw);
      if (!parsed.success) {
        result.rejectedRows.push({ rowNumber: raw.rowNumber, reason: parsed.error.issues[0]?.message ?? 'Invalid row' });
        continue;
      }
      const row = parsed.data;
      // Match archived accounts too. Names stay unique across archived and active
      // accounts, so this cannot become ambiguous, and `buildTransaction` still
      // refuses to post new rows to an archived account. Excluding them from the
      // lookup instead reported "Unknown account" for a name that plainly exists,
      // which reads as a corrupt export rather than an archived destination.
      const account = this.active(this.state.accounts).find((item) =>
        item.name.toLowerCase() === row.account.toLowerCase(),
      );
      if (!account) {
        result.rejectedRows.push({ rowNumber: row.rowNumber, reason: `Unknown account: ${row.account}` });
        continue;
      }
      if (account.archived) {
        result.rejectedRows.push({ rowNumber: row.rowNumber, reason: `Account ${account.name} is archived.` });
        continue;
      }
      try {
        if (row.currency !== account.currency) {
          throw new Error(`Currency ${row.currency} does not match ${account.name} (${account.currency}).`);
        }
        const amountMinor = parseInvariantMoney(row.amount, row.currency, this.state.settings.locale);
        const destination = row.destinationAccount
          ? this.active(this.state.accounts).find((item) =>
            item.name.toLowerCase() === row.destinationAccount.toLowerCase(),
          )
          : undefined;
        if (row.type === 'transfer' && !destination) {
          result.rejectedRows.push({ rowNumber: row.rowNumber, reason: `Unknown destination account: ${row.destinationAccount || 'missing'}` });
          continue;
        }
        if (destination?.archived) {
          result.rejectedRows.push({ rowNumber: row.rowNumber, reason: `Account ${destination.name} is archived.` });
          continue;
        }
        const category = row.category
          ? this.active(this.state.categories).find((item) =>
            item.name.toLowerCase() === row.category.toLowerCase(),
          )
          : undefined;
        if (row.category && !category) throw new Error(`Unknown category: ${row.category}`);
        if (category?.archived) throw new Error(`Category ${category.name} is archived.`);
        const tagNames = [...new Map(
          row.tags
            .split('|')
            .map((item) => item.trim())
            .filter(Boolean)
            .map((name) => [name.toLocaleLowerCase(), name]),
        ).values()];
        const input: TransactionInput = {
          kind: row.type,
          status: row.status,
          title: row.title,
          note: row.note,
          localDate: row.date,
          accountId: account.id,
          destinationAccountId: destination?.id ?? null,
          categoryId: category?.id ?? null,
          tagIds: [],
          amountMinor,
          destinationAmountMinor: destination && row.destinationAmount
            ? parseInvariantMoney(row.destinationAmount, destination.currency, this.state.settings.locale)
            : null,
          destinationBaseAmountMinor: row.destinationBaseAmountMinor
            ? this.parseMinorInteger(row.destinationBaseAmountMinor, 'Destination base amount')
            : null,
          exchangeRate: row.exchangeRate || undefined,
        };
        // Build once during preview so rate and transfer validation errors are reported per row.
        const previewTransaction = this.buildTransaction(input);
        const duplicateKey = this.transactionDuplicateKey(previewTransaction, tagNames);
        if (duplicateKeys.has(duplicateKey)) {
          result.duplicateRows.push(row.rowNumber);
          continue;
        }
        duplicateKeys.add(duplicateKey);
        result.validRows.push(row as CsvImportRow);
        staged.push({ input, tagNames });
      } catch (reason) {
        result.rejectedRows.push({
          rowNumber: row.rowNumber,
          reason: reason instanceof Error ? reason.message : 'Invalid amount or exchange rate.',
        });
      }
    }
    if (commit && staged.length) {
      const tags = [...this.state.tags];
      const newTags: Tag[] = [];
      const transactions = staged.map(({ input, tagNames }) => {
        const tagIds = tagNames.map((name) => {
          const existing = tags.find((item) => !item.deletedAt && item.name.toLowerCase() === name.toLowerCase());
          if (existing) return existing.id;
          const tag = createEntity({ id: makeId(), name, color: '#6D7885' }) as Tag;
          tags.push(tag);
          newTags.push(tag);
          return tag.id;
        });
        return this.buildTransaction({ ...input, tagIds }, undefined, tags.map((tag) => tag.id));
      });
      this.assertTransactionSetSafe([...this.state.transactions, ...transactions]);
      await this.storage.putMany([
        ...newTags.map((entity) => ({ type: 'tags' as const, entity })),
        ...transactions.map((entity) => ({ type: 'transactions' as const, entity })),
      ], this);
      // Append only the new tags onto current state; the pre-await `tags`
      // snapshot may be missing tags saved while putMany was in flight.
      this.state = {
        ...this.state,
        tags: [...this.state.tags, ...newTags],
        transactions: [...this.state.transactions, ...transactions],
      };
      result.committedIds = transactions.map((item) => item.id);
      this.emit();
    }
    if (result.rejectedRows.length) result.warnings.push('Rejected rows were not imported.');
    if (result.duplicateRows.length) result.warnings.push('Likely duplicates were skipped.');
    return result;
  }

  exportCsv() {
    const headers = ['date', 'type', 'status', 'title', 'amount', 'currency', 'account', 'destination_account', 'destination_amount', 'destination_base_amount_minor', 'category', 'tags', 'note', 'exchange_rate', 'base_amount_minor', 'transfer_id'];
    const rows = this.queryTransactions({ sort: 'oldest' }).map((transaction) => {
      const account = this.state.accounts.find((item) => item.id === transaction.accountId)?.name ?? '';
      const destination = this.state.accounts.find((item) => item.id === transaction.destinationAccountId);
      const category = this.state.categories.find((item) => item.id === transaction.categoryId)?.name ?? '';
      const tags = transaction.tagIds.map((id) => this.state.tags.find((item) => item.id === id)?.name).filter(Boolean).join('|');
      return [transaction.localDate, transaction.kind, transaction.status, transaction.title, minorToDecimalString(transaction.amountMinor, transaction.currency, this.state.settings.locale), transaction.currency, account, destination?.name ?? '', transaction.destinationAmountMinor !== null && destination ? minorToDecimalString(transaction.destinationAmountMinor, destination.currency, this.state.settings.locale) : '', transaction.destinationBaseAmountMinor ?? '', category, tags, transaction.note, transaction.exchangeRate, transaction.baseAmountMinor, transaction.transferGroupId ?? ''];
    });
    return `\uFEFF${[headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n')}`;
  }

  resetAllData() {
    return this.enqueueMutation(() => this.resetAllDataNow());
  }

  private async resetAllDataNow() {
    // Nothing below this line may touch `this.state` until the disk wipe has
    // succeeded, so a failing `clear()` leaves the snapshot intact.
    await this.storage.clear(this);
    const next = { ...createInitialState(), ready: true };
    this.deletedOccurrenceKeys.clear();
    this.state = next;
    this.emit();
    // Nothing is re-seeded. The wipe is already the source of truth: an empty store
    // rehydrates to exactly `createInitialState()` on next launch, and a reset returns the
    // app to onboarding, which is what writes the settings row. Seeding a placeholder here
    // would put the app default base currency into that row's `create` op — see the note in
    // `initializeNow` for why a `createOnly` field written from a placeholder is a trap.
  }

  private enqueueMutation<T>(operation: () => Promise<T>) {
    const run = this.mutationQueue.then(async () => {
      this.mutationActive = true;
      try {
        return await operation();
      } finally {
        this.mutationActive = false;
      }
    });
    // Draining inside the queue chain keeps the reload ordered against the next
    // mutation, and calling `hydrateFromStorage` directly avoids re-entering
    // `enqueueMutation` on the very promise being assigned here.
    this.mutationQueue = run.then(this.drainExternalRefresh, this.drainExternalRefresh);
    return run;
  }

  // Deliberately synchronous when there is nothing to drain: returning a promise
  // unconditionally would add microtask latency to every mutation handoff, which
  // is observable to callers that interleave work between queued mutations.
  private drainExternalRefresh = () => {
    if (!this.pendingExternalRefresh || !this.state.ready) return undefined;
    this.pendingExternalRefresh = false;
    return this.hydrateFromStorage().then(
      () => this.emit(),
      () => {
        // Leave the snapshot untouched and retry after the next mutation rather
        // than rejecting, which would wedge the queue for every later call.
        this.pendingExternalRefresh = true;
      },
    );
  };

  private async hydrateFromStorage() {
    const settingsRecords = await this.storage.readAll('settings');
    const settings = (settingsRecords.find((item) => item.id === 'settings' && !item.deletedAt) ??
      initialSettings()) as AppSettings;
    const loaded = await Promise.all(ENTITY_TYPES.map((type) => this.storage.readAll(type)));
    const loadedTransactions = loaded[ENTITY_TYPES.indexOf('transactions')] as TransactionRecord[];
    this.deletedOccurrenceKeys = new Set(
      loadedTransactions
        .filter((transaction) => transaction.deletedAt && transaction.occurrenceKey)
        .map((transaction) => transaction.occurrenceKey!),
    );
    // Carry the current readiness rather than asserting it. Hydration is only the
    // first step of `initializeNow`; migrations, the settings seed, and recurring
    // generation still follow. Flipping `ready` here published a half-initialized
    // snapshot to any render that polled `getSnapshot` before `emit()` ran.
    const next = { ...createInitialState(), settings, ready: this.state.ready } as FinanceState;
    ENTITY_TYPES.forEach((type, index) => {
      (next[type] as FinanceEntity[]) = loaded[index].filter((entity) => !entity.deletedAt);
    });
    this.state = next;
  }

  private async saveListEntity<T extends FinanceEntity>(
    type: ListKey,
    input: Omit<T, keyof import('@/domain/models').SyncEntity>,
    id?: string,
    expectedRevision?: number,
  ) {
    const list = this.state[type] as T[];
    const existing = this.findExisting(list, id, type.slice(0, -1));
    this.assertExpectedRevision(existing, input, expectedRevision);
    const entity = existing ? updateEntity(existing, input as Partial<T>) : createEntity<T>({ id: makeId(), ...input } as T);
    await this.persist(type, [entity]);
    this.replaceInList(type, entity);
    this.emit();
    return entity;
  }

  private buildTransaction(
    input: TransactionInput,
    id?: string,
    additionalTagIds: string[] = [],
    expectedRevision?: number,
  ) {
    this.assertPositiveMinor(input.amountMinor, 'Amount');
    this.assertDate(input.localDate);
    if (!TRANSACTION_TYPES.includes(input.kind)) throw new Error('Choose a valid transaction type.');
    const status = input.status ?? 'posted';
    if (!TRANSACTION_STATUSES.includes(status)) throw new Error('Choose a valid transaction status.');
    const existing = this.findExisting(this.state.transactions, id, 'transaction');
    this.assertExpectedRevision(existing, input, expectedRevision);
    const account = this.active(this.state.accounts).find((item) => item.id === input.accountId);
    if (!account || (account.archived && existing?.accountId !== account.id)) throw new Error('Choose a valid account.');
    const destination = input.kind === 'transfer' && input.destinationAccountId
      ? this.active(this.state.accounts).find((item) => item.id === input.destinationAccountId)
      : null;
    if (
      input.kind === 'transfer' &&
      (!destination || destination.id === account.id || (destination.archived && existing?.destinationAccountId !== destination.id))
    ) {
      throw new Error('Choose a different destination account.');
    }
    const category = input.categoryId
      ? this.active(this.state.categories).find((item) => item.id === input.categoryId)
      : null;
    if (
      input.kind !== 'transfer' &&
      input.categoryId &&
      (!category || category.kind !== input.kind || (category.archived && existing?.categoryId !== category.id))
    ) {
      throw new Error(`Choose a valid ${input.kind} category.`);
    }
    // Some callers (for example recurring generation) omit tags when editing,
    // so omission means "leave them unchanged". Passing an explicit empty
    // array still clears every tag.
    const tagIds = [...new Set(input.tagIds ?? existing?.tagIds ?? [])];
    const knownTagIds = new Set([...this.state.tags.map((tag) => tag.id), ...additionalTagIds]);
    if (tagIds.some((tagId) => !knownTagIds.has(tagId))) {
      throw new Error('Choose valid tags.');
    }
    // The applied rate is a transaction snapshot, exactly like the destination
    // leg below. While the account and date are unchanged, re-resolving it
    // through the live rate table let a since-deleted rate block edits to a
    // record that already carries its own rate — renaming a transaction failed
    // with "Missing exchange rate". Reuse the stored rate unless the caller
    // supplies one or the currency pair or date actually moved.
    const preservesRateSnapshot = existing?.accountId === account.id &&
      existing.localDate === input.localDate &&
      existing.currency === account.currency;
    const rate = account.currency === this.state.settings.baseCurrency
      ? '1'
      : input.exchangeRate
        ? this.normalizeRate(input.exchangeRate)
        : preservesRateSnapshot
          ? existing.exchangeRate
          : this.resolveRate(account.currency, this.state.settings.baseCurrency, input.localDate);
    const baseAmountMinor = convertMinor(
      input.amountMinor,
      account.currency,
      this.state.settings.baseCurrency,
      rate,
      this.state.settings.locale,
    );
    let destinationAmountMinor: number | null = null;
    let destinationBaseAmountMinor: number | null = null;
    if (input.kind === 'transfer') {
      if (destination!.currency === account.currency) {
        destinationAmountMinor = input.amountMinor;
      } else if (input.destinationAmountMinor !== undefined && input.destinationAmountMinor !== null) {
        this.assertPositiveMinor(input.destinationAmountMinor, 'Destination amount');
        // Re-saving a historical transfer must never be blocked by a value that
        // is already on the record, so only a new or changed amount is checked.
        const unchangedDestinationAmount = existing?.kind === 'transfer' &&
          existing.destinationAccountId === destination!.id &&
          existing.destinationAmountMinor === input.destinationAmountMinor;
        if (!unchangedDestinationAmount) {
          this.assertManualTransferAmount(
            input.amountMinor,
            account.currency,
            input.destinationAmountMinor,
            destination!.currency,
            input.localDate,
          );
        }
        destinationAmountMinor = input.destinationAmountMinor;
      } else {
        destinationAmountMinor = convertMinor(
          input.amountMinor,
          account.currency,
          destination!.currency,
          this.resolveRate(account.currency, destination!.currency, input.localDate),
          this.state.settings.locale,
        );
      }
      const preservesDestinationSnapshot = existing?.kind === 'transfer' &&
        existing.destinationAccountId === destination!.id &&
        existing.localDate === input.localDate &&
        existing.destinationAmountMinor === destinationAmountMinor &&
        existing.destinationBaseAmountMinor !== null;
      if (input.destinationBaseAmountMinor !== undefined && input.destinationBaseAmountMinor !== null) {
        this.assertPositiveMinor(input.destinationBaseAmountMinor, 'Destination base amount');
        // A cross-currency CSV carries this as a historical snapshot. Re-resolving today's
        // editable destination-to-base rate would reject a valid export after that rate changed
        // or was deleted. Same-currency and destination-base legs remain derivable, so keep
        // their forged-value protection without making historical non-base legs unimportable.
        if (destination!.currency === this.state.settings.baseCurrency || destination!.currency === account.currency) {
          const expectedDestinationBaseAmountMinor = this.expectedDestinationBaseAmount(
            destinationAmountMinor,
            destination!.currency,
            account.currency,
            baseAmountMinor,
            input.localDate,
          );
          if (expectedDestinationBaseAmountMinor === null || input.destinationBaseAmountMinor !== expectedDestinationBaseAmountMinor) {
            throw new Error('Destination base amount does not match the destination amount and exchange rate.');
          }
        }
        destinationBaseAmountMinor = input.destinationBaseAmountMinor;
      } else if (preservesDestinationSnapshot) {
        // Historical destination-leg value is a transaction snapshot. A title,
        // note, category, or source-side edit must not revalue it through rates
        // that may have changed (or been deleted) since the transfer occurred.
        destinationBaseAmountMinor = existing.destinationBaseAmountMinor;
      } else if (destination!.currency === this.state.settings.baseCurrency) {
        destinationBaseAmountMinor = destinationAmountMinor;
      } else if (destination!.currency === account.currency) {
        destinationBaseAmountMinor = baseAmountMinor;
      } else {
        destinationBaseAmountMinor = convertMinor(
          destinationAmountMinor,
          destination!.currency,
          this.state.settings.baseCurrency,
          this.resolveRate(destination!.currency, this.state.settings.baseCurrency, input.localDate),
          this.state.settings.locale,
        );
      }
    }
    const value = {
      kind: input.kind,
      status,
      title: input.title.trim() || (input.kind === 'transfer' ? 'Transfer' : 'Untitled'),
      note: input.note?.trim() ?? '',
      localDate: input.localDate,
      accountId: account.id,
      destinationAccountId: destination?.id ?? null,
      categoryId: input.kind === 'transfer' ? null : (category?.id ?? null),
      tagIds,
      amountMinor: input.amountMinor,
      destinationAmountMinor,
      destinationBaseAmountMinor,
      currency: account.currency,
      destinationCurrency: destination?.currency ?? null,
      exchangeRate: rate,
      baseAmountMinor,
      transferGroupId: input.kind === 'transfer' ? (existing?.transferGroupId ?? makeId()) : null,
      recurringRuleId: input.recurringRuleId ?? existing?.recurringRuleId ?? null,
      occurrenceKey: input.occurrenceKey ?? existing?.occurrenceKey ?? null,
    } satisfies Omit<TransactionRecord, keyof import('@/domain/models').SyncEntity>;
    return existing
      ? updateEntity(existing, value)
      // A generated occurrence gets an id derived from its occurrence key, so two devices
      // that both foreground and run `generateRecurring` produce the *same* transaction
      // rather than two that a later merge has to notice and deduplicate. Manually entered
      // transactions have no occurrence key and stay random.
      : createEntity({
        id: value.occurrenceKey ? occurrenceTransactionId(value.occurrenceKey) : makeId(),
        ...value,
      }) as TransactionRecord;
  }

  private replaceInList(type: ListKey, entity: FinanceEntity) {
    const list = this.state[type] as FinanceEntity[];
    const exists = list.some((item) => item.id === entity.id);
    this.state = { ...this.state, [type]: exists ? list.map((item) => item.id === entity.id ? entity : item) : [...list, entity] };
  }

  private async persist(type: EntityType, entities: FinanceEntity[]) {
    await this.storage.putMany(entities.map((entity) => ({ type, entity }) satisfies StoredEntity), this);
  }

  private active<T extends FinanceEntity>(entities: T[]) {
    return entities.filter((entity) => !entity.deletedAt);
  }

  private resolveRate(
    fromValue: string,
    toValue: string,
    localDate: string,
    exchangeRates = this.state.exchangeRates,
  ) {
    const fromCurrency = this.normalizeCurrency(fromValue);
    const toCurrency = this.normalizeCurrency(toValue);
    this.assertDate(localDate);
    if (fromCurrency === toCurrency) return '1';
    const direct = this.directOrInverseRate(fromCurrency, toCurrency, localDate, exchangeRates);
    if (direct) return direct;
    const baseCurrency = this.state.settings.baseCurrency;
    if (fromCurrency !== baseCurrency && toCurrency !== baseCurrency) {
      const fromBase = this.directOrInverseRate(fromCurrency, baseCurrency, localDate, exchangeRates);
      const toBase = this.directOrInverseRate(toCurrency, baseCurrency, localDate, exchangeRates);
      if (fromBase && toBase) return new Decimal(fromBase).div(toBase).toSignificantDigits(20).toString();
    }
    if (fromCurrency === baseCurrency) {
      const toBase = this.directOrInverseRate(toCurrency, baseCurrency, localDate, exchangeRates);
      if (toBase) return new Decimal(1).div(toBase).toSignificantDigits(20).toString();
    }
    throw new Error(`Missing exchange rate for ${fromCurrency} → ${toCurrency} on ${localDate}.`);
  }

  // A pair may be entered in either direction. If both directions exist and they
  // disagree, a transfer converts out through one and back in through the other,
  // so the two legs no longer describe the same amount and the difference is
  // conjured into (or out of) the base-currency totals. Reject the contradiction
  // at entry rather than letting it silently corrupt every later conversion.
  private assertReciprocalRate(fromCurrency: string, toCurrency: string, rate: string, effectiveDate: string, id?: string) {
    const rates = this.active(this.state.exchangeRates).filter((item) => item.id !== id);
    const nextDirectDate = rates
      .filter((item) =>
        item.fromCurrency === fromCurrency &&
        item.toCurrency === toCurrency &&
        item.effectiveDate > effectiveDate,
      )
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))[0]?.effectiveDate;
    const opposite = rates
      .filter((item) => item.fromCurrency === toCurrency && item.toCurrency === fromCurrency)
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.updatedAt.localeCompare(b.updatedAt));
    const effectiveReciprocal = opposite
      .filter((item) => item.effectiveDate <= effectiveDate)
      .at(-1);
    const laterReciprocals = opposite.filter((item) =>
      item.effectiveDate > effectiveDate &&
      (!nextDirectDate || item.effectiveDate < nextDirectDate),
    );
    const reciprocals = [effectiveReciprocal, ...laterReciprocals]
      .filter((item): item is ExchangeRate => Boolean(item));
    const entered = new Decimal(rate);
    for (const reciprocal of reciprocals) {
      const implied = new Decimal(1).div(this.normalizeRate(reciprocal.rate));
      // Manually entered rates carry real spread and rounding, so compare with a
      // tolerance instead of demanding an exact reciprocal.
      const drift = entered.minus(implied).abs().div(implied);
      if (drift.lessThanOrEqualTo(RECIPROCAL_RATE_TOLERANCE)) continue;
      throw new Error(
        `This contradicts the existing ${toCurrency} → ${fromCurrency} rate of ${reciprocal.rate}, which implies ${implied.toSignificantDigits(8)}. Update or remove that rate first.`,
      );
    }
  }

  private directOrInverseRate(
    fromCurrency: string,
    toCurrency: string,
    localDate: string,
    exchangeRates = this.state.exchangeRates,
  ) {
    const direct = this.latestRate(fromCurrency, toCurrency, localDate, exchangeRates);
    if (direct) return this.normalizeRate(direct.rate);
    const inverse = this.latestRate(toCurrency, fromCurrency, localDate, exchangeRates);
    if (!inverse) return null;
    return new Decimal(1).div(this.normalizeRate(inverse.rate)).toSignificantDigits(20).toString();
  }

  private latestRate(
    fromCurrency: string,
    toCurrency: string,
    localDate: string,
    exchangeRates = this.state.exchangeRates,
  ) {
    return this.active(exchangeRates)
      .filter((item) => item.fromCurrency === fromCurrency && item.toCurrency === toCurrency && item.effectiveDate <= localDate)
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  // A deficit compounds across every period it is carried through, so a few
  // months of overspending can drive the rollover far enough negative that the
  // effective limit turns permanently unreachable and the budget becomes
  // useless. Cap the carried deficit at a single period's limit — one period of
  // debt is a meaningful signal, ten is noise.
  private clampRollover(rolloverMinor: number, limitMinor: number) {
    const floor = -Math.abs(limitMinor);
    const ceiling = Number.MAX_SAFE_INTEGER - limitMinor;
    return Math.max(floor, Math.min(ceiling, rolloverMinor));
  }

  // Pre-indexes the selected ids and the category tree once so hierarchy
  // matching is O(depth) per transaction instead of O(categories) per transaction.
  private categoryMatcher(selectedIds: string[]) {
    const selected = new Set(selectedIds);
    const byId = new Map(this.state.categories.map((category) => [category.id, category]));
    return (categoryId: string | null) => {
      if (!categoryId) return false;
      let currentId: string | null = categoryId;
      const visited = new Set<string>();
      while (currentId && !visited.has(currentId)) {
        if (selected.has(currentId)) return true;
        visited.add(currentId);
        currentId = byId.get(currentId)?.parentId ?? null;
      }
      return false;
    };
  }

  private assertBudgetSetSafe(budgets: Budget[]) {
    const maximumEffectiveLimits = this.active(budgets)
      .filter((budget) => !budget.archived)
      .map((budget) => budget.rollover
        ? addMinor(
          budget.limitMinor,
          Math.min(budget.limitMinor, Number.MAX_SAFE_INTEGER - budget.limitMinor),
          `${budget.name} maximum effective limit`,
        )
        : budget.limitMinor);
    sumMinor(maximumEffectiveLimits, 'Budget limit total');
  }

  private budgetSpend(filters: BudgetFilters, fromDate: string, toDate: string) {
    const matchesCategory = filters.categoryIds.length ? this.categoryMatcher(filters.categoryIds) : null;
    return sumMinor(this.queryTransactions({ fromDate, toDate, statuses: ['posted'], kinds: ['expense'], sort: false })
      .filter((item) => !filters.accountIds.length || filters.accountIds.includes(item.accountId))
      .filter((item) => !matchesCategory || matchesCategory(item.categoryId))
      .filter((item) => !filters.tagIds.length || filters.tagIds.some((id) => item.tagIds.includes(id)))
      .map((item) => item.baseAmountMinor), 'Budget spending');
  }

  private async ensureBudgetSnapshots() {
    const periods = this.active(this.state.budgets)
      .filter((item) => !item.archived)
      .flatMap((budget) => this.buildBudgetSnapshots(budget, false));
    if (!periods.length) return 0;
    await this.persist('budgetPeriods', periods);
    periods.forEach((period) => this.replaceInList('budgetPeriods', period));
    return periods.length;
  }

  // A snapshot belongs to the budget's current period definition only if resolving
  // that definition on the snapshot's own start date reproduces the same window.
  // Snapshots do not store the definition they were built from, so this is how a
  // stale one is recognised after the user edits unit, interval, or anchor date.
  private matchesPeriodDefinition(budget: Budget, snapshot: BudgetPeriodSnapshot) {
    const bounds = resolvePeriod(budget.period, snapshot.periodStart);
    return bounds.start === snapshot.periodStart && bounds.end === snapshot.periodEnd;
  }

  private buildBudgetSnapshots(
    budget: Budget,
    updateCurrent: boolean,
    onDate = todayLocal(),
    transient = false,
  ) {
    const bounds = resolvePeriod(budget.period, onDate);
    const existing = this.state.budgetPeriods.find((item) => item.budgetId === budget.id && item.periodStart === bounds.start);
    if (existing) {
      if (!updateCurrent) return [];
      // A matching start alone is not enough: changing July monthly to a
      // July–August window finds the same snapshot, but its rollover belongs
      // to the old definition. Carrying it forward would grant (or charge) a
      // period that no longer exists, so only preserve it when the complete
      // resolved window still matches.
      const preservesDefinition = this.matchesPeriodDefinition(budget, existing);
      return [updateEntity(existing, {
        periodEnd: bounds.end,
        limitMinor: budget.limitMinor,
        rolloverMinor: budget.rollover && preservesDefinition ? existing.rolloverMinor : 0,
        filters: budget.filters,
        categoryLimits: budget.categoryLimits,
      })];
    }
    const history = this.state.budgetPeriods
      // `periodEnd`, not `periodStart`: a snapshot that merely *started* earlier can
      // still be running. Editing a budget's unit/interval/anchor moves `bounds.start`
      // off every stored snapshot, and the old selection then rolled over from a
      // window whose spend total was not final yet.
      .filter((item) => item.budgetId === budget.id && item.periodEnd < bounds.start)
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    const candidate = history.at(-1);
    // Roll over only from a window the current definition would still produce.
    // Otherwise a budget switched from monthly to weekly inherits a whole month's
    // unspent limit into its first week.
    const latest = candidate && this.matchesPeriodDefinition(budget, candidate) ? candidate : undefined;
    const makePeriod = (periodStart: string, periodEnd: string, previous?: BudgetPeriodSnapshot) => {
      const values = {
        budgetId: budget.id,
        periodStart,
        periodEnd,
        limitMinor: budget.limitMinor,
        rolloverMinor: budget.rollover && previous
          ? this.clampRollover(subtractMinor(
            addMinor(previous.rolloverMinor, previous.limitMinor, `${budget.name} rollover`),
            this.budgetSpend(previous.filters, previous.periodStart, previous.periodEnd),
            `${budget.name} rollover`,
          ), budget.limitMinor)
          : 0,
        filters: budget.filters,
        categoryLimits: budget.categoryLimits,
      };
      // A period that has not rolled over yet is rebuilt on every read. Minting
      // a fresh UUID and timestamps each time made the snapshot identity churn
      // between two identical reads, so any list key or memo derived from it
      // changed on every render. Derive a stable identity instead.
      //
      // The persisted path uses the same derivation, for two reasons. Two devices
      // foregrounding on the first of a month would otherwise each mint a snapshot for the
      // same `(budgetId, periodStart)`; the history sort then ties, `.at(-1)` picks
      // arbitrarily, and rollover diverges between them — a wrong number on screen rather
      // than a crash. And sharing the derivation means a transient snapshot keeps its
      // identity when it is later persisted, instead of the list key changing underneath.
      const id = budgetPeriodId(budget.id, periodStart);
      if (!transient) return createEntity({ id, ...values }) as BudgetPeriodSnapshot;
      return {
        ...values,
        id,
        revision: 1,
        createdAt: budget.createdAt,
        updatedAt: budget.updatedAt,
        deletedAt: null,
      } satisfies BudgetPeriodSnapshot;
    };
    if (!latest || updateCurrent || budget.period.unit === 'custom') {
      return [makePeriod(bounds.start, bounds.end, latest)];
    }
    const periods: BudgetPeriodSnapshot[] = [];
    let previous = latest;
    let guard = 0;
    while (previous.periodStart < bounds.start && guard < 3660) {
      guard += 1;
      const nextBounds = resolvePeriod(budget.period, addRecurrence(previous.periodEnd, 'day', 1));
      if (nextBounds.start <= previous.periodStart || nextBounds.start > bounds.start) break;
      const period = makePeriod(nextBounds.start, nextBounds.end, previous);
      periods.push(period);
      previous = period;
    }
    if (!periods.some((period) => period.periodStart === bounds.start)) {
      periods.push(makePeriod(bounds.start, bounds.end, previous));
    }
    return periods;
  }

  private validateBudget(input: BudgetInput): BudgetInput {
    this.assertPositiveMinor(input.limitMinor, 'Budget limit');
    this.assertDate(input.period.anchorDate);
    if (!Number.isSafeInteger(input.period.interval) || input.period.interval < 1) {
      throw new Error('Budget interval must be a positive whole number.');
    }
    if (!PERIOD_UNITS.includes(input.period.unit)) throw new Error('Choose a valid budget period.');
    if (input.period.unit === 'custom') {
      if (!input.period.endDate) throw new Error('Custom budgets require an end date.');
      this.assertDate(input.period.endDate);
      if (input.period.endDate < input.period.anchorDate) throw new Error('Budget end date must not precede its start date.');
    }
    this.assertIdsExist(input.filters.accountIds, this.state.accounts, 'account');
    this.assertIdsExist(input.filters.tagIds, this.state.tags, 'tag');
    this.assertIdsExist(input.filters.categoryIds, this.state.categories.filter((item) => item.kind === 'expense'), 'expense category');
    const limitedCategories = new Set<string>();
    input.categoryLimits.forEach((limit) => {
      this.assertPositiveMinor(limit.limitMinor, 'Category limit');
      if (limitedCategories.has(limit.categoryId)) throw new Error('Each category can have only one limit.');
      limitedCategories.add(limit.categoryId);
      if (!input.filters.categoryIds.includes(limit.categoryId)) {
        throw new Error('Category limits must belong to the budget filters.');
      }
    });
    this.assertColor(input.color);
    return {
      ...input,
      name: input.name.trim() || 'Budget',
      color: input.color.toUpperCase(),
      filters: {
        accountIds: [...new Set(input.filters.accountIds)],
        categoryIds: [...new Set(input.filters.categoryIds)],
        tagIds: [...new Set(input.filters.tagIds)],
      },
      categoryLimits: input.categoryLimits.map((limit) => ({ ...limit })),
      period: { ...input.period, endDate: input.period.unit === 'custom' ? input.period.endDate : null },
    };
  }

  private validateGoal(input: GoalInput, id?: string): GoalInput {
    const existing = this.findExisting(this.state.goals, id, 'goal');
    if (!GOAL_KINDS.includes(input.kind)) throw new Error('Choose a valid goal kind.');
    this.assertPositiveMinor(input.targetMinor, 'Goal target');
    this.assertSafeMinor(input.initialMinor, 'Starting progress');
    if (input.initialMinor < 0) throw new Error('Starting progress cannot be negative.');
    if (input.targetDate) this.assertDate(input.targetDate);
    if (input.linkedAccountId) {
      const account = this.state.accounts.find((item) => item.id === input.linkedAccountId);
      if (!account || (account.archived && existing?.linkedAccountId !== account.id)) {
        throw new Error('Choose a valid linked account.');
      }
    }
    if (input.linkedCategoryId) {
      const expectedKind = input.kind === 'saving' ? 'income' : 'expense';
      const category = this.state.categories.find((item) => item.id === input.linkedCategoryId);
      if (
        !category ||
        category.kind !== expectedKind ||
        (category.archived && existing?.linkedCategoryId !== category.id)
      ) {
        throw new Error(`Choose a valid ${expectedKind} category.`);
      }
    }
    this.assertColor(input.color);
    return { ...input, name: input.name.trim() || 'Goal', color: input.color.toUpperCase() };
  }

  private validateRecurring(input: RecurringInput, id?: string): RecurringInput {
    const existing = this.findExisting(this.state.recurringRules, id, 'recurring rule');
    if (!CATEGORY_KINDS.includes(input.template.kind)) throw new Error('Choose a valid recurring transaction kind.');
    if (!RECURRENCE_UNITS.includes(input.unit)) throw new Error('Choose a valid recurrence period.');
    this.assertPositiveMinor(input.template.amountMinor, 'Recurring amount');
    this.assertDate(input.startDate);
    this.assertDate(input.nextDueDate);
    if (input.endDate) {
      this.assertDate(input.endDate);
      if (input.endDate < input.startDate) throw new Error('Schedule end date must not precede its start date.');
    }
    if (!Number.isSafeInteger(input.interval) || input.interval < 1) throw new Error('Repeat interval must be a positive whole number.');
    const account = this.state.accounts.find((item) => item.id === input.template.accountId);
    if (!account || (account.archived && existing?.template.accountId !== account.id)) {
      throw new Error('Choose a valid account.');
    }
    if (this.normalizeCurrency(input.template.currency) !== account.currency) {
      throw new Error('Recurring currency must match its account.');
    }
    if (account.currency !== this.state.settings.baseCurrency) {
      this.resolveRate(account.currency, this.state.settings.baseCurrency, input.nextDueDate);
    }
    if (input.template.categoryId) {
      const category = this.state.categories.find((item) => item.id === input.template.categoryId);
      if (
        !category ||
        category.kind !== input.template.kind ||
        (category.archived && existing?.template.categoryId !== category.id)
      ) {
        throw new Error(`Choose a valid ${input.template.kind} category.`);
      }
    }
    this.assertIdsExist(input.template.tagIds, this.state.tags, 'tag');
    const referencesArchivedEntity = account.archived ||
      Boolean(input.template.categoryId &&
        this.state.categories.find((item) => item.id === input.template.categoryId)?.archived);
    return {
      ...input,
      active: input.active && !referencesArchivedEntity,
      interval: Math.floor(input.interval),
      template: {
        ...input.template,
        title: input.template.title.trim() || 'Recurring transaction',
        note: input.template.note.trim(),
        currency: account.currency,
        tagIds: [...new Set(input.template.tagIds)],
      },
    };
  }

  private async migrateLoadedState() {
    const transactionUpdates = this.state.transactions.flatMap((transaction) => {
      const destinationBaseAmountMinor = (
        transaction as TransactionRecord & { destinationBaseAmountMinor?: number | null }
      ).destinationBaseAmountMinor;
      if (transaction.kind !== 'transfer') {
        if (
          transaction.destinationAccountId === null &&
          transaction.destinationAmountMinor === null &&
          destinationBaseAmountMinor === null &&
          transaction.destinationCurrency === null &&
          transaction.transferGroupId === null
        ) return [];
        return [updateEntity(transaction, {
          destinationAccountId: null,
          destinationAmountMinor: null,
          destinationBaseAmountMinor: null,
          destinationCurrency: null,
          transferGroupId: null,
        })];
      }
      if (
        typeof destinationBaseAmountMinor === 'number' &&
        isSafeMinor(destinationBaseAmountMinor) &&
        destinationBaseAmountMinor > 0
      ) return [];
      return [updateEntity(transaction, {
        destinationBaseAmountMinor: this.legacyTransferInflowBaseMinor(transaction),
      })];
    });
    const accountMigration = this.disambiguateNames(this.state.accounts);
    const categoryMigration = this.disambiguateNames(this.state.categories);
    const tagMigration = this.disambiguateNames(this.state.tags);
    const recurringRuleUpdates = this.state.recurringRules.flatMap((rule) =>
      typeof (rule as RecurringRule & { pausedByDependency?: boolean }).pausedByDependency === 'boolean'
        ? []
        : [updateEntity(rule, { pausedByDependency: false })],
    );
    const records: StoredEntity[] = [
      ...transactionUpdates.map((entity) => ({ type: 'transactions' as const, entity })),
      ...accountMigration.changed.map((entity) => ({ type: 'accounts' as const, entity })),
      ...categoryMigration.changed.map((entity) => ({ type: 'categories' as const, entity })),
      ...tagMigration.changed.map((entity) => ({ type: 'tags' as const, entity })),
      ...recurringRuleUpdates.map((entity) => ({ type: 'recurringRules' as const, entity })),
    ];
    if (!records.length) return;
    await this.storage.putMany(records, this);
    const transactionReplacements = new Map(transactionUpdates.map((entity) => [entity.id, entity]));
    const recurringRuleReplacements = new Map(recurringRuleUpdates.map((entity) => [entity.id, entity]));
    this.state = {
      ...this.state,
      accounts: accountMigration.entities,
      categories: categoryMigration.entities,
      tags: tagMigration.entities,
      transactions: this.state.transactions.map((entity) => transactionReplacements.get(entity.id) ?? entity),
      recurringRules: this.state.recurringRules.map((entity) => recurringRuleReplacements.get(entity.id) ?? entity),
    };
  }

  private legacyTransferInflowBaseMinor(transaction: TransactionRecord) {
    const destinationAmount = transaction.destinationAmountMinor;
    const destinationCurrency = transaction.destinationCurrency;
    if (destinationAmount === null || !destinationCurrency) return transaction.baseAmountMinor;
    if (destinationCurrency === this.state.settings.baseCurrency) return destinationAmount;
    if (destinationCurrency === transaction.currency) return transaction.baseAmountMinor;
    try {
      return convertMinor(
        destinationAmount,
        destinationCurrency,
        this.state.settings.baseCurrency,
        this.resolveRate(destinationCurrency, this.state.settings.baseCurrency, transaction.localDate),
        this.state.settings.locale,
      );
    } catch {
      return transaction.baseAmountMinor;
    }
  }

  /**
   * Resolve name collisions on load, using the same pure function the merge's repair pass
   * calls.
   *
   * The naming itself lives in `@/utils/naming` rather than here because the two have to
   * agree exactly: the repair emits no ops, so convergence depends on every device deriving
   * the same names from the same merged set — and a second copy of this logic is a copy
   * that drifts. All that is left here is turning renames into entity updates.
   */
  private disambiguateNames<T extends Account | Category | Tag>(entities: T[]) {
    const replacements = new Map<string, T>();
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    for (const rename of disambiguateNames(entities)) {
      const entity = byId.get(rename.id);
      if (entity) replacements.set(rename.id, updateEntity(entity, { name: rename.name } as Partial<T>));
    }
    return {
      entities: entities.map((entity) => replacements.get(entity.id) ?? entity),
      changed: [...replacements.values()],
    };
  }

  private withEntity<T extends FinanceEntity>(entities: T[], entity: T) {
    return entities.some((item) => item.id === entity.id)
      ? entities.map((item) => item.id === entity.id ? entity : item)
      : [...entities, entity];
  }

  private assertRecurringRuleGenerationSafe(
    rule: RecurringRule,
    currentTransactions: TransactionRecord[],
    horizonDate: string,
  ) {
    if (!rule.active) return;
    const today = todayLocal();
    const transactions = currentTransactions.map((transaction) =>
      rule.autoPost &&
      transaction.recurringRuleId === rule.id &&
      transaction.status === 'upcoming' &&
      transaction.localDate <= today
        ? updateEntity(transaction, { status: 'posted' })
        : transaction,
    );
    let due = rule.nextDueDate;
    let guard = 0;
    while (due <= horizonDate && guard < MAX_RECURRING_OCCURRENCES_PER_RUN) {
      guard += 1;
      if (rule.endDate && due > rule.endDate) break;
      const occurrenceKey = `${rule.id}:${due}`;
      if (
        !this.deletedOccurrenceKeys.has(occurrenceKey) &&
        !transactions.some((transaction) => transaction.occurrenceKey === occurrenceKey)
      ) {
        transactions.push(this.buildTransaction({
          ...rule.template,
          localDate: due,
          status: rule.autoPost && due <= today ? 'posted' : 'upcoming',
          recurringRuleId: rule.id,
          occurrenceKey,
        }));
      }
      const nextDue = addRecurrence(due, rule.unit, Math.max(1, rule.interval), rule.startDate);
      if (nextDue <= due) throw new Error('Recurring schedule did not advance.');
      due = nextDue;
    }
    if (guard >= MAX_RECURRING_OCCURRENCES_PER_RUN && due <= horizonDate) {
      throw new Error('Recurring schedule has too many occurrences to generate in one run.');
    }
    this.assertTransactionSetSafe(transactions);
  }

  private calculateGoalProgress(
    goalId: string,
    goals: Goal[],
    contributions: GoalContribution[],
    transactions: TransactionRecord[],
  ) {
    const goal = goals.find((item) => item.id === goalId);
    if (!goal) throw new Error('Choose a valid goal.');
    const manual = sumMinor(
      contributions
        .filter((item) => {
          if (item.goalId !== goal.id || item.deletedAt) return false;
          if (!item.transactionId) return true;
          const transaction = transactions.find((candidate) => candidate.id === item.transactionId);
          return Boolean(transaction && !transaction.deletedAt && transaction.status === 'posted');
        })
        .map((item) => item.amountMinor),
      `${goal.name} contributions`,
    );
    if (!goal.linkedAccountId && !goal.linkedCategoryId) {
      return addMinor(goal.initialMinor, manual, `${goal.name} progress`);
    }
    let linked = 0;
    const matchesCategory = goal.linkedCategoryId ? this.categoryMatcher([goal.linkedCategoryId]) : null;
    for (const item of transactions) {
      if (item.deletedAt || item.status !== 'posted') continue;
      if (matchesCategory && !matchesCategory(item.categoryId)) continue;
      if (goal.kind === 'spending') {
        if (item.kind !== 'expense') continue;
        if (goal.linkedAccountId && item.accountId !== goal.linkedAccountId) continue;
        linked = addMinor(linked, item.baseAmountMinor, `${goal.name} progress`);
        continue;
      }
      if (goal.linkedCategoryId) {
        if (item.kind !== 'income') continue;
        if (goal.linkedAccountId && item.accountId !== goal.linkedAccountId) continue;
        linked = addMinor(linked, item.baseAmountMinor, `${goal.name} progress`);
        continue;
      }
      if (!goal.linkedAccountId) continue;
      if (item.kind === 'income' && item.accountId === goal.linkedAccountId) {
        linked = addMinor(linked, item.baseAmountMinor, `${goal.name} progress`);
      } else if (
        (item.kind === 'expense' || item.kind === 'transfer') &&
        item.accountId === goal.linkedAccountId
      ) {
        linked = subtractMinor(linked, item.baseAmountMinor, `${goal.name} progress`);
      } else if (item.kind === 'transfer' && item.destinationAccountId === goal.linkedAccountId) {
        linked = addMinor(linked, this.transferInflowBaseMinor(item), `${goal.name} progress`);
      }
    }
    return addMinor(
      addMinor(goal.initialMinor, manual, `${goal.name} progress`),
      linked,
      `${goal.name} progress`,
    );
  }

  private assertGoalProgressSafe(
    goalId: string,
    goals: Goal[],
    contributions: GoalContribution[],
    transactions = this.state.transactions,
  ) {
    this.calculateGoalProgress(goalId, goals, contributions, transactions);
  }

  /**
   * The overflow gate for a merged set.
   *
   * Deliberately *not* `assertTransactionSetSafe`. That one reads `this.state.goals` and
   * `this.state.settings` and calls `todayLocal()` inside its net-worth pass, so it is not a
   * pure function of its arguments — two devices in different timezones could disagree about
   * whether the same merge is legal, and the op log would fork. This keeps only the passes
   * that depend on nothing but the records in front of them, which is also the cheaper half:
   * no rate resolution, no per-goal walk.
   *
   * Anything it rejects is a merged state no local mutation could have produced, so failing
   * closed here is the whole point — nothing is written and the batch can be retried.
   */
  private assertMergedSetSafe(repaired: ReturnType<typeof repairMergedState>) {
    const {
      settings,
      accounts,
      categories,
      tags,
      transactions,
      budgets,
      budgetPeriods,
      goals,
      contributions,
      recurringRules,
      exchangeRates,
    } = repaired;
    this.assertMergedDomainValues({
      settings,
      accounts,
      categories,
      tags,
      transactions,
      budgets,
      budgetPeriods,
      goals,
      contributions,
      recurringRules,
      exchangeRates,
    });
    const posted = transactions.filter((item) => !item.deletedAt && item.status === 'posted');
    for (const account of accounts.filter((item) => !item.deletedAt)) {
      const label = `${account.name} balance`;
      let balance = account.openingBalanceMinor;
      this.assertSafeMinor(balance, label);
      for (const transaction of posted) {
        if (transaction.accountId === account.id) {
          balance = transaction.kind === 'income'
            ? addMinor(balance, transaction.amountMinor, label)
            : subtractMinor(balance, transaction.amountMinor, label);
        }
        if (transaction.kind === 'transfer' && transaction.destinationAccountId === account.id) {
          balance = addMinor(balance, transaction.destinationAmountMinor ?? 0, label);
        }
      }
    }
    sumMinor(
      posted.filter((item) => item.kind === 'income').map((item) => item.baseAmountMinor),
      'Income total',
    );
    sumMinor(
      posted.filter((item) => item.kind === 'expense').map((item) => item.baseAmountMinor),
      'Expense total',
    );
  }

  /**
   * Remote ops are authenticated, not inherently valid finance input. This is deliberately
   * pure and complete enough to reject every value shape that the local mutation paths refuse,
   * before a malformed projection is allowed to poison future local saves.
   */
  private assertMergedDomainValues({
    settings,
    accounts,
    categories,
    tags,
    transactions,
    budgets,
    budgetPeriods,
    goals,
    contributions,
    recurringRules,
    exchangeRates,
  }: Parameters<typeof repairMergedState>[0]) {
    const assertText = (value: unknown, label: string) => {
      if (typeof value !== 'string') throw new Error(`${label} must be text.`);
    };
    const assertDate = (value: unknown, label: string) => {
      if (typeof value !== 'string' || !isLocalDate(value)) throw new Error(`${label} must be a calendar date.`);
    };
    const assertMinor = (value: unknown, label: string, positive = false) => {
      if (typeof value !== 'number' || !isSafeMinor(value) || (positive && value <= 0)) {
        throw new Error(`${label} must be ${positive ? 'a positive ' : 'a '}safe minor-unit integer.`);
      }
    };
    const assertCurrency = (value: unknown, label: string) => {
      if (typeof value !== 'string' || !isSupportedCurrencyCode(value)) {
        throw new Error(`${label} must be a supported currency.`);
      }
    };
    const assertEnum = (value: unknown, values: readonly string[], label: string) => {
      if (typeof value !== 'string' || !values.includes(value)) throw new Error(`${label} is invalid.`);
    };
    const assertRate = (value: unknown, label: string) => {
      if (typeof value !== 'string') throw new Error(`${label} must be a decimal string.`);
      let rate: Decimal;
      try {
        rate = new Decimal(value);
      } catch {
        throw new Error(`${label} must be a decimal string.`);
      }
      if (!rate.isFinite() || rate.lte(0)) throw new Error(`${label} must be positive.`);
    };

    // A freshly paired device can receive account and transaction history before its settings
    // create reaches it. Hold the settings-specific checks until that create lands rather than
    // rejecting otherwise well-formed history.
    if (settings) {
      assertCurrency(settings.baseCurrency, 'Base currency');
      assertEnum(settings.themeMode, THEME_MODES, 'Theme mode');
      assertEnum(settings.accentSource, ACCENT_SOURCES, 'Accent source');
      if (validateLocale(settings.locale)) throw new Error('Settings locale is invalid.');
    }

    for (const account of accounts) {
      assertEnum(account.type, ACCOUNT_TYPES, 'Account type');
      assertCurrency(account.currency, 'Account currency');
      assertMinor(account.openingBalanceMinor, 'Opening balance');
    }
    for (const category of categories) assertEnum(category.kind, CATEGORY_KINDS, 'Category kind');
    for (const tag of tags) assertText(tag.name, 'Tag name');
    for (const transaction of transactions) {
      assertEnum(transaction.kind, TRANSACTION_TYPES, 'Transaction type');
      assertEnum(transaction.status, TRANSACTION_STATUSES, 'Transaction status');
      assertDate(transaction.localDate, 'Transaction date');
      assertMinor(transaction.amountMinor, 'Transaction amount', true);
      assertMinor(transaction.baseAmountMinor, 'Transaction base amount', true);
      assertCurrency(transaction.currency, 'Transaction currency');
      assertRate(transaction.exchangeRate, 'Transaction exchange rate');
      const source = accounts.find((account) => account.id === transaction.accountId);
      if (!source || source.currency !== transaction.currency) throw new Error('Transaction currency must match its account.');
      if (transaction.kind === 'transfer') {
        const destination = accounts.find((account) => account.id === transaction.destinationAccountId);
        if (!destination || transaction.destinationAmountMinor === null || transaction.destinationBaseAmountMinor === null ||
          transaction.destinationCurrency !== destination.currency) {
          throw new Error('Transfer destination does not match its account.');
        }
        assertMinor(transaction.destinationAmountMinor, 'Transfer destination amount', true);
        assertMinor(transaction.destinationBaseAmountMinor, 'Transfer destination base amount', true);
      } else if (transaction.destinationAccountId !== null || transaction.destinationAmountMinor !== null ||
        transaction.destinationBaseAmountMinor !== null || transaction.destinationCurrency !== null || transaction.transferGroupId !== null) {
        throw new Error('Non-transfer transaction has transfer fields.');
      }
    }
    for (const budget of budgets) {
      assertMinor(budget.limitMinor, 'Budget limit', true);
      assertEnum(budget.period.unit, PERIOD_UNITS, 'Budget period');
      assertDate(budget.period.anchorDate, 'Budget anchor date');
      if (!Number.isSafeInteger(budget.period.interval) || budget.period.interval < 1) throw new Error('Budget interval is invalid.');
      if (budget.period.unit === 'custom' && (!budget.period.endDate || !isLocalDate(budget.period.endDate))) throw new Error('Custom budget end date is invalid.');
      for (const limit of budget.categoryLimits) assertMinor(limit.limitMinor, 'Budget category limit', true);
    }
    for (const period of budgetPeriods) {
      assertDate(period.periodStart, 'Budget period start');
      assertDate(period.periodEnd, 'Budget period end');
      assertMinor(period.limitMinor, 'Budget period limit', true);
      assertMinor(period.rolloverMinor, 'Budget period rollover');
    }
    for (const goal of goals) {
      assertEnum(goal.kind, GOAL_KINDS, 'Goal kind');
      assertMinor(goal.targetMinor, 'Goal target', true);
      assertMinor(goal.initialMinor, 'Goal initial progress');
      if (goal.initialMinor < 0) throw new Error('Goal initial progress cannot be negative.');
      if (goal.targetDate !== null) assertDate(goal.targetDate, 'Goal target date');
    }
    for (const contribution of contributions) {
      assertMinor(contribution.amountMinor, 'Contribution amount', true);
      assertDate(contribution.localDate, 'Contribution date');
    }
    for (const rule of recurringRules) {
      assertEnum(rule.template.kind, CATEGORY_KINDS, 'Recurring transaction type');
      assertCurrency(rule.template.currency, 'Recurring transaction currency');
      assertMinor(rule.template.amountMinor, 'Recurring transaction amount', true);
      assertEnum(rule.unit, RECURRENCE_UNITS, 'Recurring period');
      if (!Number.isSafeInteger(rule.interval) || rule.interval < 1) throw new Error('Recurring interval is invalid.');
      assertDate(rule.startDate, 'Recurring start date');
      assertDate(rule.nextDueDate, 'Recurring next date');
      if (rule.endDate !== null) assertDate(rule.endDate, 'Recurring end date');
      const account = accounts.find((item) => item.id === rule.template.accountId);
      if (!account || account.currency !== rule.template.currency) throw new Error('Recurring currency must match its account.');
    }
    for (const rate of exchangeRates) {
      assertCurrency(rate.fromCurrency, 'Exchange-rate source currency');
      assertCurrency(rate.toCurrency, 'Exchange-rate destination currency');
      assertDate(rate.effectiveDate, 'Exchange-rate date');
      assertRate(rate.rate, 'Exchange rate');
    }
  }

  private assertTransactionSetSafe(
    transactions: TransactionRecord[],
    accounts = this.state.accounts,
    exchangeRates = this.state.exchangeRates,
  ) {
    const posted = transactions.filter((item) => !item.deletedAt && item.status === 'posted');
    const balances = new Map<string, number>();
    for (const account of accounts.filter((item) => !item.deletedAt)) {
      let balance = account.openingBalanceMinor;
      this.assertSafeMinor(balance, `${account.name} balance`);
      for (const transaction of posted) {
        if (transaction.accountId === account.id) {
          if (transaction.kind === 'income') {
            balance = addMinor(balance, transaction.amountMinor, `${account.name} balance`);
          } else {
            balance = subtractMinor(balance, transaction.amountMinor, `${account.name} balance`);
          }
        }
        if (transaction.kind === 'transfer' && transaction.destinationAccountId === account.id) {
          balance = addMinor(
            balance,
            transaction.destinationAmountMinor ?? 0,
            `${account.name} balance`,
          );
        }
      }
      balances.set(account.id, balance);
    }
    sumMinor(
      posted.filter((item) => item.kind === 'income').map((item) => item.baseAmountMinor),
      'Income total',
    );
    sumMinor(
      posted.filter((item) => item.kind === 'expense').map((item) => item.baseAmountMinor),
      'Expense total',
    );
    this.state.goals.forEach((goal) => {
      this.assertGoalProgressSafe(goal.id, this.state.goals, this.state.contributions, transactions);
    });
    let netWorth = 0;
    // Archived accounts are included so this overflow guard covers exactly the
    // set `getDashboard` now sums, rather than a narrower one.
    for (const account of accounts.filter((item) => !item.deletedAt)) {
      let rate: string;
      try {
        rate = this.resolveRate(
          account.currency,
          this.state.settings.baseCurrency,
          todayLocal(),
          exchangeRates,
        );
      } catch {
        continue;
      }
      netWorth = addMinor(
        netWorth,
        convertMinor(
          balances.get(account.id) ?? account.openingBalanceMinor,
          account.currency,
          this.state.settings.baseCurrency,
          rate,
          this.state.settings.locale,
        ),
        'Net worth',
      );
    }
  }

  // A manual destination amount carries real spread and fees, so it is never
  // required to agree with the stored rate. A misplaced decimal point, though,
  // lands orders of magnitude away and silently conjures value into (or out of)
  // every later base-currency total, with nothing on screen to show for it.
  // Reject only that, and only when a rate for the pair is actually known.
  private assertManualTransferAmount(
    amountMinor: number,
    fromCurrency: string,
    destinationAmountMinor: number,
    toCurrency: string,
    localDate: string,
  ) {
    let expected: number;
    try {
      expected = convertMinor(
        amountMinor,
        fromCurrency,
        toCurrency,
        this.resolveRate(fromCurrency, toCurrency, localDate),
        this.state.settings.locale,
      );
    } catch {
      return;
    }
    if (expected <= 0) return;
    const ratio = destinationAmountMinor / expected;
    if (
      ratio >= 1 / MANUAL_TRANSFER_AMOUNT_TOLERANCE &&
      ratio <= MANUAL_TRANSFER_AMOUNT_TOLERANCE
    ) return;
    throw new Error(
      `Destination amount is far from the known ${fromCurrency} → ${toCurrency} rate for ${localDate}. Check the amount, or update the rate first.`,
    );
  }

  /**
   * Reconstructs the base snapshot that a CSV row is allowed to claim.
   *
   * A destination-base snapshot is historical data, but a CSV is editable and the value affects
   * linked goal progress. The source-side snapshot is enough when both legs use the same
   * currency; otherwise the destination leg must be priced by the current effective rate. A
   * missing rate is deliberately unverifiable rather than a reason to trust the supplied number.
   */
  private expectedDestinationBaseAmount(
    destinationAmountMinor: number,
    destinationCurrency: string,
    sourceCurrency: string,
    sourceBaseAmountMinor: number,
    localDate: string,
  ): number | null {
    if (destinationCurrency === this.state.settings.baseCurrency) return destinationAmountMinor;
    if (destinationCurrency === sourceCurrency) return sourceBaseAmountMinor;
    try {
      return convertMinor(
        destinationAmountMinor,
        destinationCurrency,
        this.state.settings.baseCurrency,
        this.resolveRate(destinationCurrency, this.state.settings.baseCurrency, localDate),
        this.state.settings.locale,
      );
    } catch {
      return null;
    }
  }

  // Inclusive whole-day count. Compared through UTC midnights so a daylight
  // saving transition inside the range cannot shift the total by a day.
  private daySpan(fromDate: string, toDate: string) {
    const from = parseLocalDate(fromDate);
    const to = parseLocalDate(toDate);
    const fromUtc = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
    const toUtc = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
    return Math.round((toUtc - fromUtc) / 86_400_000) + 1;
  }

  private parseMinorInteger(value: string, label: string) {
    const normalized = value.trim();
    if (!/^-?\d+$/.test(normalized)) throw new Error(`${label} must be a whole number.`);
    const parsed = Number(normalized);
    this.assertSafeMinor(parsed, label);
    return parsed;
  }

  private transactionDuplicateKey(transaction: TransactionRecord, suppliedTagNames?: string[]) {
    const tagNames = suppliedTagNames ?? transaction.tagIds.map((id) =>
      this.state.tags.find((tag) => tag.id === id)?.name ?? id,
    );
    return JSON.stringify([
      transaction.localDate,
      transaction.kind,
      transaction.status,
      transaction.accountId,
      transaction.destinationAccountId,
      transaction.amountMinor,
      transaction.destinationAmountMinor,
      transaction.currency,
      transaction.destinationCurrency,
      transaction.categoryId,
      transaction.title.trim().toLocaleLowerCase(),
      transaction.note.trim().toLocaleLowerCase(),
      [...new Set(tagNames.map((name) => name.trim().toLocaleLowerCase()))].sort(),
      transaction.exchangeRate,
    ]);
  }

  private findExisting<T extends FinanceEntity>(entities: T[], id: string | undefined, label: string) {
    if (!id) return undefined;
    const existing = entities.find((item) => item.id === id);
    if (!existing) throw new Error(`Could not find the ${label} to update.`);
    return existing;
  }

  private assertExpectedRevision(
    existing: FinanceEntity | undefined,
    _input: object,
    expectedRevision?: number,
  ) {
    if (!existing) return;
    if (expectedRevision !== undefined && expectedRevision !== existing.revision) {
      throw new Error('This record changed in another window. Reopen it and try again.');
    }
  }

  private assertUniqueName(type: 'accounts' | 'categories' | 'tags', name: string, id?: string) {
    // `normalizeName` rather than `toLocaleLowerCase`, and the same one `disambiguateNames`
    // uses. Case folding is locale-dependent — in a Turkish locale `'I'` folds to `'ı'` —
    // so the two would otherwise disagree about what counts as a collision, and a set the
    // load migration had just declared clean could still be rejected by every later save.
    const duplicate = (this.state[type] as (Account | Category | Tag)[]).some((item) =>
      item.id !== id &&
      normalizeName(item.name) === normalizeName(name),
    );
    if (duplicate) throw new Error(`${name} is already in use.`);
  }

  private assertIdsExist<T extends FinanceEntity>(ids: string[], entities: T[], label: string) {
    const known = new Set(entities.map((item) => item.id));
    if (ids.some((id) => !known.has(id))) throw new Error(`Choose valid ${label} values.`);
  }

  private normalizeCurrency(value: string) {
    const currency = value.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Use a three-letter currency code such as USD.');
    if (!isSupportedCurrencyCode(currency)) throw new Error('Use a supported ISO 4217 currency code.');
    return currency;
  }

  private normalizeRate(value: string) {
    let rate: Decimal;
    try {
      rate = new Decimal(value.trim());
    } catch {
      throw new Error('Exchange rate must be a positive number.');
    }
    if (!rate.isFinite() || !rate.isPositive()) throw new Error('Exchange rate must be a positive number.');
    // `toFixed`, not `toString`: decimal.js switches to exponential notation below
    // 1e-7 (`toExpNeg`), which real pairs such as IRR→BHD reach. Rates are stored as
    // decimal strings, and `normalizeDecimalString` would reject "8.9e-9" if such a
    // value were ever fed back through form input.
    return rate.toSignificantDigits(20).toFixed();
  }

  private assertLocale(value: string) {
    const error = validateLocale(value);
    if (error) throw new Error(error);
  }

  private assertColor(value: string) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(value)) throw new Error('Use a six-digit hex color such as #5966E9.');
  }

  private assertDate(value: string) {
    if (!isLocalDate(value)) throw new Error('Use a real date in YYYY-MM-DD format.');
  }

  private assertSafeMinor(value: number, label: string) {
    if (!isSafeMinor(value)) throw new Error(`${label} is outside the supported range.`);
  }

  private assertPositiveMinor(value: number, label: string) {
    this.assertSafeMinor(value, label);
    if (value <= 0) throw new Error(`${label} must be greater than zero.`);
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}

/**
 * The app's storage, with change capture wrapped around it.
 *
 * Installed unconditionally and left **unarmed** — it captures nothing until
 * `SyncProvider` calls `setDeviceId` with a vault's device id. Wrapping it here rather than
 * only once sync is switched on is what makes turning sync on a pure configuration change:
 * the alternative would be swapping the adapter under a repository that is already holding a
 * snapshot and a subscription, at the exact moment the user is least willing to lose data.
 *
 * Exported because the provider needs the handle to arm it. Nothing else should touch it.
 */
export const syncingStorage = new SyncingStorageAdapter(new PlatformStorageAdapter(), null);

export const financeRepository = new LocalFinanceRepository(syncingStorage);
