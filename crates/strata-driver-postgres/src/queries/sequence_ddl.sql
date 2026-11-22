SELECT pg_catalog.format(
    'AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s CACHE %s %s',
    seqtypid::regtype, seqincrement, seqmin, seqmax, seqstart, seqcache,
    CASE WHEN seqcycle THEN 'CYCLE' ELSE 'NO CYCLE' END
)
FROM pg_catalog.pg_sequence
WHERE seqrelid = $1::oid
