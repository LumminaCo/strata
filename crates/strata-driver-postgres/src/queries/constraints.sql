SELECT conname::text, pg_catalog.pg_get_constraintdef(oid, true)
FROM pg_catalog.pg_constraint
WHERE conrelid = $1::oid
ORDER BY conname
