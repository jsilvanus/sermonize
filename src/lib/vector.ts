/**
 * Vector helpers shared by embedding ingestion, search and the index CLI.
 *
 * Vectors travel to PostgreSQL as pgvector text literals (`'[1,2,3]'`) and are
 * stored in the untyped `embedding.vector` column. Search and HNSW indexes use
 * a typed cast of that column, chosen per embedding space:
 *
 *   dimensions ≤ 2000         vector(N)   (HNSW on vector supports ≤ 2000 dims)
 *   2000 < dimensions ≤ 4000  halfvec(N)  (HNSW on halfvec supports ≤ 4000 dims)
 *   dimensions > 4000         vector(N)   (no index possible; exact scan only)
 *
 * The same cast expression is used by the index and by search, so the planner
 * can match the partial expression index.
 */

export type Metric = 'cosine' | 'inner_product' | 'l2';

/** Largest dimension an HNSW index can cover (halfvec). */
export const MAX_INDEX_DIMENSIONS = 4000;
/** Largest dimension for which the full-precision `vector` type is indexable. */
export const MAX_VECTOR_INDEX_DIMENSIONS = 2000;
/** Largest finite half-precision float. */
export const HALFVEC_MAX = 65504;
/** Largest finite single-precision float (pgvector stores float4 elements). */
export const FLOAT4_MAX = 3.4028234663852886e38;

/** pgvector distance operator per metric. `<#>` returns the NEGATIVE inner product. */
export const DISTANCE_OPERATOR: Record<Metric, string> = {
  cosine: '<=>',
  inner_product: '<#>',
  l2: '<->',
};

/** `vector` or `halfvec`: the element type used for search/indexing in a space of this dimension. */
export function searchType(dimensions: number): 'vector' | 'halfvec' {
  return dimensions > MAX_VECTOR_INDEX_DIMENSIONS && dimensions <= MAX_INDEX_DIMENSIONS ? 'halfvec' : 'vector';
}

/** The typed cast (e.g. `vector(768)`, `halfvec(3072)`) for a space. */
export function castType(dimensions: number): string {
  if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error(`invalid dimensions: ${dimensions}`);
  return `${searchType(dimensions)}(${dimensions})`;
}

/** HNSW operator class for a space (e.g. `vector_cosine_ops`, `halfvec_ip_ops`). */
export function opclass(metric: Metric, dimensions: number): string {
  const suffix = metric === 'cosine' ? 'cosine' : metric === 'inner_product' ? 'ip' : 'l2';
  return `${searchType(dimensions)}_${suffix}_ops`;
}

/** Name of the partial HNSW index of a space: `embedding_hnsw_<32 hex digits of the id>`. */
export function indexName(spaceId: string): string {
  const hex = spaceId.toLowerCase().replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`invalid embedding space id: ${spaceId}`);
  return `embedding_hnsw_${hex}`;
}

/** pgvector text literal. Numbers use JS shortest round-trip formatting. */
export function toVectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

/** Parses a pgvector/halfvec text value (`[1,2.5,-3]`) as returned by node-pg. */
export function parseVector(text: string): number[] {
  const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (inner.trim() === '') return [];
  return inner.split(',').map(Number);
}

/**
 * Checks a vector against a space: length, finite values within the element
 * range of the type used for storage/search, non-zero for cosine, and unit
 * length for `normalized` spaces. Returns a reason string, or null if valid.
 */
export function vectorProblem(
  values: readonly number[],
  space: { dimensions: number; metric: Metric; normalized: boolean },
  opts: { checkNormalized?: boolean } = {},
): string | null {
  if (values.length !== space.dimensions) {
    return `vector has ${values.length} dimensions, space requires ${space.dimensions}`;
  }
  const max = searchType(space.dimensions) === 'halfvec' ? HALFVEC_MAX : FLOAT4_MAX;
  let sumSq = 0;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'vector contains a non-finite value';
    if (Math.abs(v) > max) return `vector value ${v} is out of range (|x| <= ${max})`;
    sumSq += v * v;
  }
  if (space.metric === 'cosine' && sumSq === 0) return 'zero vector has no cosine distance';
  if ((opts.checkNormalized ?? true) && space.normalized && Math.abs(Math.sqrt(sumSq) - 1) > 1e-2) {
    return `space is normalized but vector norm is ${Math.sqrt(sumSq).toPrecision(6)}`;
  }
  return null;
}
