import * as Crypto from 'expo-crypto';

import type { SyncEntity } from '@/domain/models';

export function nowIso() {
  return new Date().toISOString();
}

export function makeId() {
  return Crypto.randomUUID();
}

export function createEntity<T extends object>(
  value: T & { id?: string },
): T & SyncEntity {
  const timestamp = nowIso();
  return {
    ...value,
    id: value.id ?? makeId(),
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  };
}

export function updateEntity<T extends SyncEntity>(entity: T, patch: Partial<T>): T {
  return {
    ...entity,
    ...patch,
    id: entity.id,
    createdAt: entity.createdAt,
    updatedAt: nowIso(),
    revision: entity.revision + 1,
  };
}
