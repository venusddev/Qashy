import type { EntityType, FinanceEntity } from '@/domain/models';

export interface StoredEntity {
  type: EntityType;
  entity: FinanceEntity;
}

export function compareStoredEntities(first: FinanceEntity, second: FinanceEntity) {
  const updatedOrder = first.updatedAt.localeCompare(second.updatedAt);
  if (updatedOrder) return updatedOrder;
  const firstName = 'name' in first && typeof first.name === 'string'
    ? first.name.trim().toLowerCase()
    : '';
  const secondName = 'name' in second && typeof second.name === 'string'
    ? second.name.trim().toLowerCase()
    : '';
  return firstName.localeCompare(secondName) || first.id.localeCompare(second.id);
}

export interface StorageAdapter {
  initialize(): Promise<void>;
  readAll(type: EntityType): Promise<FinanceEntity[]>;
  putMany(records: StoredEntity[]): Promise<void>;
  clear(): Promise<void>;
}
