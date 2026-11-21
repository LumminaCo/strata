CREATE TABLE type_zoo (
    id NUMBER(9) PRIMARY KEY,
    exact_value NUMBER(38,10),
    label NVARCHAR2(64),
    clock_value DATE,
    instant TIMESTAMP WITH TIME ZONE,
    elapsed INTERVAL DAY TO SECOND,
    raw_value RAW(16),
    long_value LONG,
    text_value CLOB,
    blob_value BLOB
);

INSERT INTO type_zoo VALUES (
    1, 9999999999999999999999999999.9999999999, UNISTR('Mu\00F1oz \D83E\DD16'),
    TO_DATE('2026-01-20 10:30:00', 'YYYY-MM-DD HH24:MI:SS'),
    TO_TIMESTAMP_TZ('2026-01-20 10:30:00 -05:00', 'YYYY-MM-DD HH24:MI:SS TZH:TZM'),
    INTERVAL '2 03:04:05' DAY TO SECOND,
    HEXTORAW('00FF'), 'Legacy text', EMPTY_CLOB(), EMPTY_BLOB()
);

INSERT INTO type_zoo (id) VALUES (2);

DECLARE
    sample_clob CLOB;
    sample_blob BLOB;
BEGIN
    SELECT text_value, blob_value INTO sample_clob, sample_blob
    FROM type_zoo WHERE id = 1 FOR UPDATE;

    FOR chunk IN 1 .. 40 LOOP
        DBMS_LOB.WRITEAPPEND(sample_clob, 30000, RPAD('á', 30000, 'a'));
    END LOOP;
    DBMS_LOB.WRITEAPPEND(sample_blob, 2, HEXTORAW('00FF'));
END;
/

CREATE TABLE people (
    id NUMBER(9) PRIMARY KEY,
    full_name NVARCHAR2(64) NOT NULL,
    city NVARCHAR2(32) NOT NULL,
    joined_on DATE NOT NULL
);

INSERT INTO people
SELECT LEVEL,
       CASE MOD(LEVEL, 5)
           WHEN 0 THEN N'Lucía' WHEN 1 THEN N'Miguel' WHEN 2 THEN N'Óscar'
           WHEN 3 THEN N'María José' ELSE N'Juan David'
       END || N' ' || CASE MOD(LEVEL, 7)
           WHEN 0 THEN N'Rincón' WHEN 1 THEN N'Muñoz' WHEN 2 THEN N'Peña'
           WHEN 3 THEN N'Pérez' WHEN 4 THEN N'Ibáñez' WHEN 5 THEN N'López' ELSE N'Cárdenas'
       END,
       CASE MOD(LEVEL, 6)
           WHEN 0 THEN N'Bogotá' WHEN 1 THEN N'Medellín' WHEN 2 THEN N'Quibdó'
           WHEN 3 THEN N'Ibagué' WHEN 4 THEN N'Popayán' ELSE N'Tumaco'
       END,
       DATE '2018-01-01' + MOD(LEVEL, 2500)
FROM dual CONNECT BY LEVEL <= 1000000;

CREATE SYNONYM demo_people FOR people;
COMMIT;
