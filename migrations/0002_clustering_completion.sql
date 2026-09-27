-- Phase 4: clustering run completion and withdrawal.
--
-- 0001 made `cluster` fully insert-only, but a run's cluster sizes are only known
-- once all memberships are in. This migration:
--   * lets `cluster.size` be filled once (NULL -> value) while the run is open;
--   * on open -> complete, requires at least one membership, fills NULL sizes from
--     the memberships and rejects sizes that disagree with them;
--   * adds `clustering_run.withdrawn_reason` (set only by the withdraw transition).
--
-- `cluster.size` is the number of memberships assigned to the cluster or to any
-- of its descendant clusters (for a flat clustering: its direct members).

-- Membership count of every cluster of a run, including descendants.
CREATE FUNCTION cluster_subtree_counts(p_run uuid)
RETURNS TABLE (cluster_id uuid, cluster_number integer, size integer, member_count integer)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE tree (root_id, id) AS (
    SELECT c.id, c.id FROM cluster c WHERE c.clustering_run_id = p_run
    UNION ALL
    SELECT t.root_id, c.id
      FROM tree t JOIN cluster c ON c.parent_cluster_id = t.id AND c.clustering_run_id = p_run
  ) CYCLE id SET is_cycle USING path,
  direct AS (
    SELECT m.cluster_id, count(*)::integer AS n
      FROM cluster_membership m
     WHERE m.clustering_run_id = p_run AND m.cluster_id IS NOT NULL
     GROUP BY m.cluster_id
  )
  SELECT c.id, c.cluster_number, c.size, coalesce(sum(d.n), 0)::integer
    FROM cluster c
    JOIN tree t ON t.root_id = c.id AND NOT t.is_cycle
    LEFT JOIN direct d ON d.cluster_id = t.id
   WHERE c.clustering_run_id = p_run
   GROUP BY c.id, c.cluster_number, c.size
$$;

-- cluster: insert-only except filling `size` once while the run is open.
CREATE FUNCTION cluster_guard_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cluster records cannot be deleted' USING ERRCODE = 'SZ002';
  END IF;
  IF (to_jsonb(NEW) - 'size') IS DISTINCT FROM (to_jsonb(OLD) - 'size') THEN
    RAISE EXCEPTION 'cluster records are immutable (only a NULL size can be filled while the run is open)'
      USING ERRCODE = 'SZ002';
  END IF;
  IF NEW.size IS DISTINCT FROM OLD.size THEN
    IF OLD.size IS NOT NULL THEN
      RAISE EXCEPTION 'size of cluster % is already set', OLD.cluster_number USING ERRCODE = 'SZ002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM clustering_run WHERE id = NEW.clustering_run_id AND status = 'open') THEN
      RAISE EXCEPTION 'cluster sizes can only be set while the clustering run is open' USING ERRCODE = 'SZ003';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER a_insert_only ON cluster;
CREATE TRIGGER a_insert_only BEFORE UPDATE OR DELETE ON cluster
  FOR EACH ROW EXECUTE FUNCTION cluster_guard_mutation();

-- clustering_run.withdrawn_reason
ALTER TABLE clustering_run ADD COLUMN withdrawn_reason text;
ALTER TABLE clustering_run ADD CONSTRAINT clustering_run_withdrawn_reason_check
  CHECK (withdrawn_reason IS NULL OR status = 'withdrawn');

DROP TRIGGER a_insert_only ON clustering_run;
CREATE TRIGGER a_insert_only BEFORE UPDATE OR DELETE ON clustering_run
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('status', 'completed_at', 'withdrawn_reason');

-- Runs after c_status_guard (which validates the transition itself).
CREATE FUNCTION clustering_run_transition_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bad record;
BEGIN
  IF NEW.withdrawn_reason IS DISTINCT FROM OLD.withdrawn_reason
     AND NOT (OLD.status <> 'withdrawn' AND NEW.status = 'withdrawn') THEN
    RAISE EXCEPTION 'withdrawn_reason can only be set when the run is withdrawn' USING ERRCODE = 'SZ002';
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'complete' THEN
    IF NOT EXISTS (SELECT 1 FROM cluster_membership WHERE clustering_run_id = NEW.id) THEN
      RAISE EXCEPTION 'clustering run % has no memberships and cannot be completed', NEW.id
        USING ERRCODE = 'SZ003';
    END IF;
    SELECT x.cluster_number, x.size, x.member_count INTO bad
      FROM cluster_subtree_counts(NEW.id) x
     WHERE x.size IS NOT NULL AND x.size <> x.member_count
     ORDER BY x.cluster_number
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'cluster % has size % but % memberships', bad.cluster_number, bad.size, bad.member_count
        USING ERRCODE = 'SZ003';
    END IF;
    -- The run row is not yet updated here, so cluster_guard_mutation() still sees it open.
    UPDATE cluster c SET size = x.member_count
      FROM cluster_subtree_counts(NEW.id) x
     WHERE c.id = x.cluster_id AND c.size IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER d_transition_check BEFORE UPDATE ON clustering_run
  FOR EACH ROW EXECUTE FUNCTION clustering_run_transition_check();
