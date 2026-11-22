ARG POSTGRES_BASE=postgres:17
FROM ${POSTGRES_BASE}
COPY 10-pagila-schema.sql 20-pagila-data.sql.gz 30-strata.sql /docker-entrypoint-initdb.d/

# Test certificates are generated per image. The CA key never leaves this layer.
RUN set -eu; \
    mkdir -p /opt/strata-pg; \
    cd /opt/strata-pg; \
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj '/CN=Strata fixture CA' \
      -keyout /tmp/strata-pg-ca.key -out ca.pem; \
    openssl req -new -newkey rsa:2048 -nodes -subj '/CN=postgres' \
      -keyout server.key -out /tmp/strata-pg.csr; \
    printf 'subjectAltName=DNS:postgres\nextendedKeyUsage=serverAuth\n' > /tmp/strata-pg.ext; \
    openssl x509 -req -in /tmp/strata-pg.csr -CA ca.pem -CAkey /tmp/strata-pg-ca.key \
      -CAcreateserial -days 3650 -extfile /tmp/strata-pg.ext -out server.pem; \
    chown postgres:postgres server.key server.pem; \
    chmod 600 server.key; \
    rm /tmp/strata-pg-ca.key /tmp/strata-pg.csr /tmp/strata-pg.ext ca.srl

COPY start.sh /usr/local/bin/strata-pg-start
ENTRYPOINT ["strata-pg-start"]
CMD ["postgres", "-c", "ssl=on", "-c", "ssl_cert_file=/opt/strata-pg/server.pem", "-c", "ssl_key_file=/opt/strata-pg/server.key"]
