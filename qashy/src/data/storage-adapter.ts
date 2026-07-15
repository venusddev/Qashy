import type { EntityType, FinanceEntity } from '@/domain/models';

export interface StoredEntity {
  type: EntityType;
  entity: FinanceEntity;
}

export interface StorageAdapter {
  initialize(): Promise<void>;
  readAll(type: EntityType): Promise<FinanceEntity[]>;
  putMany(records: StoredEntity[]): Promise<void>;
  clear(): Promise<void>;
}
