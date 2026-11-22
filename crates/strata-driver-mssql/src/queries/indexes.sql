SELECT i.name,
       CAST(CASE WHEN i.is_primary_key = 1 THEN 'PRIMARY KEY '
                 WHEN i.is_unique_constraint = 1 THEN 'UNIQUE '
                 ELSE 'CREATE ' + CASE WHEN i.is_unique = 1 THEN 'UNIQUE ' ELSE '' END
                      + 'INDEX ' + QUOTENAME(i.name) + ' ON ' + QUOTENAME(s.name) + '.' + QUOTENAME(o.name) + ' '
            END + '(' + k.columns + ')' AS nvarchar(max)),
       i.is_primary_key, i.is_unique_constraint
FROM sys.indexes AS i
JOIN sys.objects AS o ON o.object_id = i.object_id
JOIN sys.schemas AS s ON s.schema_id = o.schema_id
CROSS APPLY (SELECT STRING_AGG(CAST(QUOTENAME(c.name) + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END AS nvarchar(max)), ', ')
                    WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns
             FROM sys.index_columns AS ic
             JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
             WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0) AS k
WHERE i.object_id = @P1 AND i.name IS NOT NULL AND k.columns IS NOT NULL
ORDER BY i.name
