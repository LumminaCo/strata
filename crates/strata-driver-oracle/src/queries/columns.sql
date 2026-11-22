SELECT c.column_name,
       CASE WHEN c.data_type IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR')
                 THEN c.data_type || '(' || c.char_length || ')'
            WHEN c.data_type='NUMBER' AND c.data_precision IS NOT NULL
                 THEN 'NUMBER(' || c.data_precision || ',' || c.data_scale || ')'
            ELSE c.data_type END,
       c.nullable, c.data_default, d.comments
FROM all_tab_columns c
LEFT JOIN all_col_comments d ON d.owner=c.owner AND d.table_name=c.table_name AND d.column_name=c.column_name
WHERE c.owner=:1 AND c.table_name=:2
ORDER BY c.column_id
