# Basalt

**Your whole data stack, on one server.**

Basalt brings your company's data together and makes it useful. It copies data from your databases, files and cloud storage, protects personal data before it's stored, and gives your team one place to clean, explore and report on it.

You host it yourself, so your data stays with you.

## How it helps

Most small companies end up paying for five separate tools to move, store, transform, explore and report on data, then spend their time keeping those tools working together. Basalt does all five in one application, on a server you control.

- **One place for your data.** Bring every source together without building or maintaining pipelines.
- **Privacy from the start.** Personal data is found and masked before it reaches your analysts.
- **Answers for everyone.** Analysts can write SQL and Python. Everyone else can use filters, no-code steps and dashboards.
- **Trust in the numbers.** Row-count checks, data checks and alerts tell you when something goes wrong.

## Features

**Connect and import**
- PostgreSQL, MySQL and MariaDB
- Amazon S3 and compatible storage, Google Cloud Storage, Azure Blob Storage and ADLS Gen2, BigQuery and Snowflake
- PostgreSQL on Amazon RDS, Aurora, Cloud SQL and Azure Database, with the server certificate verified
- CSV, TSV, JSON, Parquet, Excel, XML and Delta Lake
- Airbyte connectors, run unmodified as separate processes through Docker or Python, for admins to add from Airbyte's public list
- A preview before every file import, with control over field names and types

**Sync**
- An ETL flow page to run everything, with retries, stale-data alerts and scheduled exports
- Full and incremental sync on a schedule
- Real-time sync from PostgreSQL
- Row-count checks and alerts to Slack or Teams

**Protect and govern**
- Automatic personal data detection and masking
- Roles, row-level access, an audit log and single sign-on

**Transform**
- SQL, Python and no-code steps, with a result preview at every step
- Data checks, lineage, incremental builds and snapshots that keep history

**Work together in bases**
- Editable, linked tables with 28 field types, including linked records, lookups, rollups and formulas
- Grid, kanban, gallery, calendar, timeline and form views, with filters, sorting, grouping and colours
- Record comments and change history, attachments, public forms, automations and interface pages
- Live updates between people, sync between bases, locked and personal views, built-in extensions
- A REST API with per-base tokens
- An optional copy in the warehouse, so SQL and dashboards can use a base

**Explore and report**
- Grid, board, gallery and pivot views, with filters, grouping and colour rules
- A SQL editor, data catalog and shared metrics
- Reports with pages, cross-filtering, drill-down and drill-through, matrix, decomposition tree, conditional formatting, bookmarks, what-if parameters, relationships, SQL and DAX measures, plain-English questions and email subscriptions
- A first version built for you from any table
- Export to CSV, JSON, Parquet, Excel or XML, to a download, a bucket or a cloud warehouse

## Install

You need Node 24.

```bash
npm install
npm run build
npm start
```

Open http://127.0.0.1:3000/login. The first visit creates your admin account and can load a sample company so there's data to explore.

To serve a team, put Basalt behind a reverse proxy with HTTPS. Back up the `data` folder, and keep it private because it holds your data and encryption key.

## Deploy on AWS, Azure or Google Cloud

Basalt runs as one server on any of the three clouds, and can read from and export to all of them whichever it runs on. Every cloud has the same three requirements:

- **A persistent disk for the `data` folder.** Set `BASALT_DATA` to a folder on it. Use a block disk rather than a network file share, because the warehouse is a DuckDB file.
- **One instance only.** DuckDB allows one writer, so don't run replicas or autoscale. To grow, move to a larger machine.
- **TLS in front.** Basalt serves plain HTTP, so keep its port private and put a load balancer or reverse proxy with HTTPS in front.

| | Server | Disk | TLS |
|---|---|---|---|
| AWS | EC2 | EBS | Application Load Balancer or a reverse proxy |
| Azure | Virtual Machine | Managed Disk | Application Gateway or a reverse proxy |
| Google Cloud | Compute Engine | Persistent Disk | HTTPS Load Balancer or a reverse proxy |

Follow the install steps on the machine, or build the included `Dockerfile` and mount the disk at `/data`. Basalt downloads DuckDB extensions when first needed, so it needs outbound internet access. Snapshot the disk for backups.

**Signing in to storage from the machine.** On AWS, an S3 connection can use the instance's IAM role or EKS web identity instead of an access key, but not an ECS task role. On Azure, a storage connection can use a managed identity. Google Cloud Storage needs an HMAC key, because DuckDB can't sign in with a service account.

**Managed PostgreSQL.** TLS verifies the server certificate. Paste your provider's CA certificate on the connection for RDS, Aurora and Cloud SQL. Azure Database uses public CAs, so it needs none. For Cloud SQL by IP address, also choose to check the CA only, because its certificate doesn't name the IP.

## Real-time sync

Real-time sync needs a small worker alongside Basalt, and requires Rust to build.

1. On your PostgreSQL server, set `wal_level=logical` and create a login with the `REPLICATION` role.
2. In Basalt, open the pipeline and choose **Turn on real-time sync**. Copy the settings it shows.
3. Build the worker with `cargo build --release` in the `worker` folder, then run it with those settings.
4. Run one full sync.

The worker requires TLS unless `SOURCE_URL` sets its own `sslmode`, so add `?sslmode=disable` for a local server without TLS. It checks every 200 ms (`POLL_MS`). Rebuild it after upgrading Basalt, because it now sends column types so masks match a sync.

## Event streams

On Connections, choose **Add stream**, then send JSON or NDJSON to `POST /api/ingest/<stream>` with `Authorization: Bearer <token>` and an `Idempotency-Key`. Limits: 10 MB and 50,000 events a request, 200 requests a second. Events reach `raw_events.<stream>` with the same personal data rules as a sync.

## Measured limits

One run on one Windows desktop, everything on the same machine, 13-column table of 1 to 2.3 million rows. DuckDB has one writing process, so writes batch and compete with builds.

| PostgreSQL changes a second | Commit to queryable p50 / p99 | Read p50 / p99 |
| --- | --- | --- |
| 100 | 84 / 1,072 ms | 5 / 58 ms |
| 1,000 | 76 / 204 ms | 5 / 14 ms |
| 10,000 | 144 / 424 ms | 6 / 12 ms |
| 20,000 | 387 / 718 ms | 6 / 29 ms |
| 30,000 (falls behind) | 7,769 / 22,351 ms | 8 / 36 ms |

With a table rebuild running continuously, 10,000 changes a second took 638 / 1,405 ms. Streams accepted up to 117,740 events a second in batches, with a sender on the same machine.

## Current limits

- Kafka and MySQL binlog change capture aren't built, because no broker or MySQL server was available to test them.

- No cloud connector has run against a real cloud account yet. BigQuery and Snowflake have only been tested against local test servers, S3 against an emulator, and Azure Blob Storage against the Azurite emulator. Google Cloud Storage and MySQL haven't run against a real server. Try these on your own account first.
- ADLS Gen2 is read through its Blob endpoint and hasn't been tested on a real account. Managed identity has never obtained a real token, and IAM roles have only been tested with a simulated metadata service.
- PostgreSQL certificate checks were tested on a local server with test certificates, not on RDS, Aurora, Cloud SQL or Azure Database. MySQL and MariaDB connections encrypt but don't yet verify the certificate.
- The real-time worker uses the machine's own trusted certificates, so a private CA must be installed there.
- SQL Server, Azure SQL and Azure Synapse aren't available yet. The Dockerfile hasn't been built or run yet.
- Delta Lake tables can be read but not written.
- Basalt runs on one server and doesn't spread work across machines.
- Automation scripts aren't sandboxed, so only admins can edit them.
- DAX covers measures, including time intelligence, but not calculated tables or columns. Questions in Ask match words rather than using AI.
- Email needs your own mail server, set in Settings. Set `BASALT_URL` so report emails can link back.

## Airbyte connectors and licensing

Basalt doesn't include Airbyte's code. It reads Airbyte's public connector list, then downloads and runs the connector an admin chooses, as a separate process that it talks to over the Airbyte Protocol.

- Connectors keep their own licences, shown when you choose one. At the time of writing, most connectors are under the Elastic License 2.0 (ELv2), some are MIT, and `airbyte-cdk`, which runs manifest connectors, is MIT. Connectors marked Airbyte Enterprise aren't offered.
- ELv2 allows use and distribution, but not providing the software to third parties as a hosted or managed service. Running Basalt yourself on your own data is the case this is built for. If you plan to offer Basalt to others as a hosted service with these connectors, check the licence first, or get legal advice.
- Airbyte is a trademark of its owner. Basalt isn't affiliated with or endorsed by Airbyte.

You need Docker, or Python 3 for the connectors that don't need Docker. Most Python-packaged connectors need Python 3.12 or older, which you set with `BASALT_PYTHON`. Installed connectors go in `connectors` in the data folder, or in `BASALT_AIRBYTE_HOME`.
