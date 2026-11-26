WITH direct AS (
    SELECT src_att.attname::text AS source_column,
           target_ns.nspname::text AS target_schema,
           target_rel.relname::text AS target_table,
           target_att.attname::text AS target_column,
           0 AS source_rank,
           array_length(k.conkey, 1) AS key_len,
           k.conname AS constraint_name,
           mapping.ord AS ord
    FROM pg_catalog.pg_constraint AS k
    JOIN pg_catalog.pg_class AS target_rel ON target_rel.oid = k.confrelid
    JOIN pg_catalog.pg_namespace AS target_ns ON target_ns.oid = target_rel.relnamespace
    CROSS JOIN LATERAL unnest(k.conkey, k.confkey) WITH ORDINALITY AS mapping(src_attnum, dst_attnum, ord)
    JOIN pg_catalog.pg_attribute AS src_att
      ON src_att.attrelid = k.conrelid AND src_att.attnum = mapping.src_attnum
    JOIN pg_catalog.pg_attribute AS target_att
      ON target_att.attrelid = k.confrelid AND target_att.attnum = mapping.dst_attnum
    WHERE k.contype = 'f'
      AND k.conrelid = $1::oid
),
partitioned AS (
    SELECT parent_att.attname::text AS source_column,
           target_ns.nspname::text AS target_schema,
           target_rel.relname::text AS target_table,
           target_att.attname::text AS target_column,
           1 AS source_rank,
           array_length(k.conkey, 1) AS key_len,
           k.conname AS constraint_name,
           mapping.ord AS ord
    FROM pg_catalog.pg_class AS parent
    JOIN pg_catalog.pg_inherits AS inh ON inh.inhparent = parent.oid
    JOIN pg_catalog.pg_constraint AS k ON k.conrelid = inh.inhrelid AND k.contype = 'f'
    JOIN pg_catalog.pg_class AS target_rel ON target_rel.oid = k.confrelid
    JOIN pg_catalog.pg_namespace AS target_ns ON target_ns.oid = target_rel.relnamespace
    CROSS JOIN LATERAL unnest(k.conkey, k.confkey) WITH ORDINALITY AS mapping(src_attnum, dst_attnum, ord)
    JOIN pg_catalog.pg_attribute AS child_att
      ON child_att.attrelid = k.conrelid AND child_att.attnum = mapping.src_attnum
    JOIN pg_catalog.pg_attribute AS parent_att
      ON parent_att.attrelid = parent.oid
     AND parent_att.attname = child_att.attname
     AND parent_att.attnum > 0
     AND NOT parent_att.attisdropped
    JOIN pg_catalog.pg_attribute AS target_att
      ON target_att.attrelid = k.confrelid AND target_att.attnum = mapping.dst_attnum
    WHERE parent.oid = $1::oid
      AND parent.relkind = 'p'
)
SELECT DISTINCT ON (source_column)
       source_column, target_schema, target_table, target_column
FROM (
    SELECT * FROM direct
    UNION ALL
    SELECT * FROM partitioned
) AS all_fks
ORDER BY source_column, source_rank, key_len, constraint_name, ord
