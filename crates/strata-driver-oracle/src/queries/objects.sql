SELECT o.object_id, o.owner, o.object_name, o.object_type, t.num_rows, c.comments
FROM all_objects o
LEFT JOIN all_tables t ON t.owner=o.owner AND t.table_name=o.object_name AND o.object_type='TABLE'
LEFT JOIN all_tab_comments c ON c.owner=o.owner AND c.table_name=o.object_name AND o.object_type IN ('TABLE','VIEW')
WHERE o.owner=:1 AND (:2 IS NULL OR o.object_name=:3)
  AND o.object_type IN ('TABLE','VIEW','MATERIALIZED VIEW','FUNCTION','PROCEDURE','SEQUENCE','SYNONYM')
ORDER BY o.object_name, CASE WHEN o.object_type='MATERIALIZED VIEW' THEN 0 ELSE 1 END
