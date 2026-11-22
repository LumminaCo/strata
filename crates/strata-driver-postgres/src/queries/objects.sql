SELECT c.oid, n.nspname::text, c.relname::text, c.relkind::text,
       CASE WHEN c.reltuples >= 0 AND c.relkind IN ('r', 'p', 'm', 'f') THEN c.reltuples::bigint END AS row_estimate,
       pg_catalog.obj_description(c.oid, 'pg_class')
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = $1::text AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
UNION ALL
SELECT p.oid, n.nspname::text, p.proname::text,
       CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
       NULL::bigint, pg_catalog.obj_description(p.oid, 'pg_proc')
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = $1::text AND p.prokind IN ('f', 'p')
ORDER BY 3, 4, 1
