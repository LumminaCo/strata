SELECT CASE
    WHEN c.relkind = 'f' THEN 0::bigint
    ELSE pg_catalog.pg_total_relation_size(c.oid)
END
FROM pg_catalog.pg_class AS c
WHERE c.oid = $1::oid
