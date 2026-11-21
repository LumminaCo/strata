CREATE SCHEMA strata_demo;

CREATE TABLE strata_demo.type_zoo (
    id integer PRIMARY KEY,
    active boolean,
    exact_value numeric(38,10),
    lowest_bigint bigint,
    highest_bigint bigint,
    instant timestamptz,
    duration interval,
    labels text[],
    document jsonb,
    payload bytea,
    uid uuid
);

INSERT INTO strata_demo.type_zoo VALUES
    (1, true, 9999999999999999999999999999.9999999999, '-9223372036854775808',
     9223372036854775807, '2026-01-20 10:30:00-05', '1 year 2 days',
     ARRAY['Muñoz', 'Bogotá', '🤖'], '{"city":"Medellín"}', decode('00ff', 'hex'),
     'a144e09d-e626-40bb-95ad-0560fb123456'),
    (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);

CREATE TABLE strata_demo.people (
    id integer PRIMARY KEY,
    full_name text NOT NULL,
    city text NOT NULL,
    joined_on date NOT NULL
);

INSERT INTO strata_demo.people
SELECT id,
       (ARRAY['Lucía', 'Miguel', 'Óscar', 'María José', 'Juan David'])[1 + id % 5]
           || ' ' || (ARRAY['Rincón', 'Muñoz', 'Peña', 'Pérez', 'Ibáñez', 'López', 'Cárdenas'])[1 + id % 7],
       (ARRAY['Bogotá', 'Medellín', 'Quibdó', 'Ibagué', 'Popayán', 'Tumaco'])[1 + id % 6],
       DATE '2018-01-01' + id % 2500
FROM generate_series(1, 1000000) AS source(id);
