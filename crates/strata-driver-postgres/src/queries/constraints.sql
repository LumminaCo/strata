SELECT k.conname::text, pg_catalog.pg_get_constraintdef(k.oid, true),
       n.nspname::text, target.relname::text
FROM pg_catalog.pg_constraint AS k
LEFT JOIN pg_catalog.pg_class AS target ON target.oid = k.confrelid
LEFT JOIN pg_catalog.pg_namespace AS n ON n.oid = target.relnamespace
WHERE k.conrelid = $1::oid
ORDER BY k.conname
