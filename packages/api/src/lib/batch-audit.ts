import type { PoolClient } from 'pg';

export interface BatchAuditInput {
  /** Table the rows were inserted into, e.g. 'chunk', 'embedding', 'cluster_membership'. */
  entityType: string;
  /** The parent record the batch belongs to (segmentation, embedding space, clustering run). */
  parentId?: string | null;
  /** Number of rows actually inserted. */
  count: number;
  /** Small summary (e.g. `{ skipped, parent_type }`). Never row data or PII. */
  changes?: Record<string, unknown>;
}

/**
 * Writes one `batch_insert` audit event for a bulk insert of derived rows.
 * Must be called inside withTransaction(); actor and request id are set by the
 * audit_event trigger.
 */
export async function writeBatchAudit(client: PoolClient, input: BatchAuditInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_event (action, entity_type, entity_id, batch_count, changes)
     VALUES ('batch_insert', $1, $2, $3, $4)`,
    [input.entityType, input.parentId ?? null, input.count, input.changes ?? null],
  );
}
