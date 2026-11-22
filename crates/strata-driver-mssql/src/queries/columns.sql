SELECT c.name,
       CAST(t.name + CASE
           WHEN t.name IN ('varchar','char','varbinary','binary','nvarchar','nchar')
           THEN '(' + CASE WHEN c.max_length = -1 THEN 'max'
                            ELSE CONVERT(varchar(12), c.max_length / CASE WHEN t.name IN ('nvarchar','nchar') THEN 2 ELSE 1 END)
                       END + ')'
           WHEN t.name IN ('numeric','decimal')
           THEN '(' + CONVERT(varchar(3), c.precision) + ',' + CONVERT(varchar(3), c.scale) + ')'
           WHEN t.name IN ('datetime2','datetimeoffset','time')
           THEN '(' + CONVERT(varchar(3), c.scale) + ')'
           ELSE '' END AS nvarchar(256)),
       c.is_nullable, COALESCE(d.definition, computed.definition), c.is_identity, c.is_computed,
       CONVERT(nvarchar(max), p.value)
FROM sys.columns AS c
JOIN sys.types AS t ON t.system_type_id = c.system_type_id AND t.user_type_id = t.system_type_id
LEFT JOIN sys.default_constraints AS d ON d.object_id = c.default_object_id
LEFT JOIN sys.computed_columns AS computed ON computed.object_id = c.object_id AND computed.column_id = c.column_id
LEFT JOIN sys.extended_properties AS p ON p.class = 1 AND p.major_id = c.object_id
     AND p.minor_id = c.column_id AND p.name = N'MS_Description'
WHERE c.object_id = @P1
ORDER BY c.column_id
