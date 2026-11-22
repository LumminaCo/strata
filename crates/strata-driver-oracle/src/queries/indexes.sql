SELECT i.index_name, i.uniqueness,
       LISTAGG('"' || REPLACE(c.column_name,'"','""') || '"' || CASE WHEN c.descend='DESC' THEN ' DESC' ELSE '' END, ', ')
           WITHIN GROUP (ORDER BY c.column_position)
FROM all_indexes i
JOIN all_ind_columns c ON c.index_owner=i.owner AND c.index_name=i.index_name
WHERE i.table_owner=:1 AND i.table_name=:2
GROUP BY i.index_name, i.uniqueness
ORDER BY i.index_name
