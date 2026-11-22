SELECT pg_catalog.format('%I.%I.%I', n.nspname, source.relname, k.conname),
       pg_catalog.pg_get_constraintdef(k.oid, true), n.nspname::text, source.relname::text
FROM pg_catalog.pg_constraint AS k
JOIN pg_catalog.pg_class AS source ON source.oid = k.conrelid
JOIN pg_catalog.pg_namespace AS n ON n.oid = source.relnamespace
WHERE k.confrelid = $1::oid AND k.contype = 'f'
ORDER BY 1
