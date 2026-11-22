SELECT nspname::text
FROM pg_catalog.pg_namespace
WHERE nspname NOT LIKE 'pg_toast%'
  AND nspname NOT LIKE 'pg_temp_%'
  AND ($1::boolean OR nspname NOT IN ('pg_catalog', 'information_schema'))
ORDER BY nspname
