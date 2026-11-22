SELECT c.relname::text, pg_catalog.pg_get_indexdef(i.indexrelid)
FROM pg_catalog.pg_index AS i
JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
WHERE i.indrelid = $1::oid
ORDER BY c.relname
