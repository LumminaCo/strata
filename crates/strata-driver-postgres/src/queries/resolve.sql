SELECT c.oid, n.nspname::text, c.relname::text, c.relkind::text,
       CASE WHEN c.reltuples >= 0 AND c.relkind IN ('r', 'p', 'm', 'f') THEN c.reltuples::bigint END,
       pg_catalog.obj_description(c.oid, 'pg_class')
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.oid = pg_catalog.to_regclass($1::text)
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
