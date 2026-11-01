/* Every public docs page. Write what someone does in the interface, checked against the code. Inline code is «like this», code blocks use ~~~. See markdown.ts. */
import { DAX_FUNCTIONS } from "../dax.ts";
import { FORMULA_FUNCTIONS } from "../formula.ts";
import { CUSTOM_FUNCTIONS } from "../query.ts";
import { MODEL_DAX_FUNCTIONS } from "../semantic.ts";
import { ADD_STEPS, STEP_LABELS } from "../transform.ts";

export type Topic = { slug: string; group: string; title: string; description: string; body: string };

export const DAX_REFUSED = ["CROSSJOIN", "TREATAS", "SUMMARIZECOLUMNS", "GENERATE", "UNION", "INTERSECT", "EXCEPT", "ROW", "DATATABLE", "PATH", "LOOKUPVALUE", "EARLIEST"];
const list = (a: readonly string[]) => [...a].sort().map((x) => `«${x}»`).join(", ");

export const TOPICS: Topic[] = [
  { slug: "get-started", group: "Get started", title: "Get started", description: "Sign in to Basalt, connect your first source, protect personal data and build your first dashboard.", body: `
Basalt brings your company's data into one workspace. It copies data from your sources, holds back personal data until you decide how to treat it, and gives your team one place to clean, explore and report on it.

## Sign in

Open your workspace's address and sign in with the email and password from your admin, or with single sign-on if your workspace uses it. To change what you can do, ask an admin. See [Admin](/docs/admin).

If you're the first person in a new workspace, you'll see a setup screen instead. Enter the workspace name, your name, your email and a password of at least 10 characters. You become the admin. Leave the sample company ticked if you want data to try things on.

## Where your data comes from

The Workspace page offers each way in when you have no data yet. **Connect your own data** copies from a database or cloud storage. **Upload a file** imports one. **Start in Basalt's database** gives you editable tables kept on this server, with nothing else to set up. Admins of an empty workspace can also load the sample company.

## Your first report

1. Go to **Connections** and add a database, or import a file. See [Connections](/docs/connections) and [Import files](/docs/import-files).
2. On the pipeline that opens, turn on the tables you want and choose how often they sync. See [Pipelines](/docs/pipelines).
3. Go to **Personal data** and choose a rule for each flagged column. See [Personal data](/docs/personal-data).
4. Run the sync.
5. Clean the data with a model, if it needs it. See [Models](/docs/models).
6. Go to **Dashboards** and create a dashboard from a table. See [Dashboards](/docs/dashboards).

## Find your way around

| Control | What it does |
|---|---|
| New, at the top of the sidebar | Creates a connection, file import, transformation, base, query, data view, dashboard, app, metric or member. Editors and admins only |
| Search in the top bar, or Ctrl K | Finds pages, dashboards, views, models, pipelines and tables |
| Bell | Shows failed syncs, failed checks and other alerts |
| Collapse, at the bottom of the sidebar | Shrinks the sidebar to icons |
| Docs | Opens this documentation |
` },

  { slug: "connections", group: "Bring in data", title: "Connections", description: "Connect PostgreSQL, MySQL, MariaDB, Amazon S3, Google Cloud Storage, Azure storage, BigQuery and Snowflake to Basalt.", body: `
A connection tells Basalt where a source is and how to sign in to it. Each connection gets a pipeline.

## Add a connection

1. Go to **Connections** and choose the source.
2. Enter its details.
3. Choose **Test connection**. You can't save until a test passes.
4. Save. Basalt opens the connection's pipeline.

Use a read-only login, and a read replica if you have one. Basalt opens database sessions as read-only. Passwords and keys are encrypted and are never shown again.

## What you can connect

| Source | You need | Basalt can write to it |
|---|---|---|
| PostgreSQL, MySQL, MariaDB | Host, port, database, user, password | No |
| Amazon S3, MinIO, Cloudflare R2 | Bucket, plus an access key and secret. A custom endpoint for MinIO and R2 | When you export |
| Google Cloud Storage | Bucket, plus an HMAC key and secret, created under Cloud Storage settings, Interoperability | When you export |
| Azure Blob Storage, ADLS Gen2 | Container, plus a storage account and key, or a connection string | When you export |
| Google BigQuery | Project ID, dataset and a service account key in JSON | When you export |
| Snowflake | Account identifier, user, warehouse, database and an unencrypted PEM private key registered to that user | When you export |

The Cloud Storage form also offers **Service account**. Paste the JSON key file, and give the account the **Storage Object Viewer** role on the bucket, or **Storage Object User** to export there. Basalt's token from the key lasts an hour, so one file read or export has to finish within that time.

The Azure form also offers **Service principal**, which many companies require instead of account keys. Enter the storage account, tenant ID, client ID and client secret, and give the app the **Storage Blob Data Reader** role on the container, or **Storage Blob Data Contributor** to export there. A new role can take up to 10 minutes to apply.

S3, DynamoDB and Athena also offer **A role in your AWS account**, so you don't share a key with Basalt. The form shows a trust policy with an external ID made for your workspace. Create a role with that policy and read access to your data, then paste its ARN. Basalt refuses a role that works without the external ID, because anyone else could then use it. Basalt's keys for a role last an hour, so one file read or export to S3 has to finish within that time.

The S3 form also offers **This server's own IAM role**, and the Azure form **Managed identity**. Both depend on how your workspace is set up, so ask your admin before choosing them. Managed identity is marked as not tested on Azure.

These read-only sources are in the same list. Basalt never writes to them.

| Source | What you enter |
|---|---|
| Amazon DynamoDB | Region, plus an access key and secret or the server's IAM role. An optional limit on read capacity |
| Amazon Redshift, including Serverless | Endpoint, database, user and password |
| Amazon Athena | Region, database, an optional workgroup and results location, plus an access key and secret or the server's IAM role |
| Amazon RDS, Aurora, Cloud SQL, Azure Database | The PostgreSQL or MySQL form, with guidance on the CA certificate |
| Firestore | Service account key in JSON, and a database ID if it isn't the default |
| Spanner | Instance, database and a service account key in JSON. GoogleSQL databases only |
| SQL Server, Azure SQL | Server, database, user and password |
| Azure Synapse | SQL endpoint, database, user and password |
| Cosmos DB | Account URI, database and a read-only key. NoSQL API only |

DynamoDB, Firestore and Cosmos DB have no fixed columns. Basalt works out the columns from a small sample. A field it hasn't seen, or a value that doesn't fit its column, goes into a column called \`_extra_fields\`, which is checked for personal data on every row and held back if any is found. Later rows can't fail a sync this way.

Incremental syncs on DynamoDB still read the whole table, because a scan filters after reading. Read capacity is limited to 100 units a second unless you set another limit. Firestore reads top-level collections only.

SQLite and Databricks can't be connected yet.

## How storage becomes tables

- A folder of files in the same format becomes one table.
- A folder with «_delta_log» is read as a Delta Lake table. Delta Lake can be read but not written.
- A loose file is its own table.

Files can be CSV, TSV, JSON, JSON lines, Parquet, Avro, Excel or XML.

## Database certificates

For PostgreSQL, **Encrypt the connection with TLS** verifies the server's certificate.

| Provider | What to do |
|---|---|
| Amazon RDS, Aurora, Cloud SQL | Paste the provider's CA certificate |
| Azure Database | Leave the CA certificate empty |
| Cloud SQL by IP address | Paste the CA certificate, and tick **Check the CA only**, because its certificate doesn't name the IP |

MySQL and MariaDB connections are encrypted, but their certificate isn't verified yet.
` },

  { slug: "airbyte-connectors", group: "Bring in data", title: "Airbyte connectors", description: "Add a source from Airbyte's public connector list in Basalt, and what licences and limits apply.", body: `
Admins can add sources such as a SaaS app or an API from Airbyte's public connector list. Basalt doesn't include Airbyte's code. It installs the connector you choose, unmodified, and runs it as a separate program.

## Add one

1. Go to **Connections**, choose **Add connection**, and search. Choose **Apps** to see only Airbyte connectors. Only admins see them.
2. Choose a connector. The card shows its licence and version. One that can't run in your workspace is shown turned off.
3. Fill in the form, which comes from the connector's own settings. There's a link to Airbyte's setup guide when the connector has one.
4. Test it. Testing installs and runs the connector, and is recorded in the audit log.
5. Save, and choose streams on its pipeline.

Rows then go through the same steps as any source: personal data checks, sync modes, run history and alerts.

## What to expect

- Only admins can install or run a connector by hand. A schedule on a saved connection keeps running.
- Settings, including secrets, are encrypted and never shown again.
- Connectors can't report a total row count, so these streams have no row check.
- Each sync reads the first rows of a stream that has columns with no rule, to check their values. That costs a little extra API use.
- A field the connector doesn't declare in its catalog isn't copied, and the run says so.
- Progress is saved only after rows are committed. If a large first sync fails, it starts again.
- A connector can send a row twice. If that matters, use **Incremental: add and update by key** with a primary key.
- A connector's logo loads from Airbyte's website.

## Licences

Each connector keeps its own licence, shown when you choose it. Most are under the Elastic License 2.0 (ELv2), and some are MIT. ELv2 doesn't allow providing the software to third parties as a hosted or managed service, so check the licence if that's what you plan to do with a connector. Connectors marked Airbyte Enterprise aren't offered.

Airbyte is a trademark of its owner. Basalt isn't affiliated with or endorsed by Airbyte.

## Tested so far

Only Sample Data and PokeAPI have been run, not a paid service. Sample Data ran incrementally: a second sync read 0 new rows and the copy stayed correct. Try a connector on your own account before you rely on it.

Many Python connectors don't support the newest Python. Sample Data 7.2.1 refused Python 3.13 and ran on 3.12. If a connector says so, your administrator can run Basalt with an older Python. Connectors published only as container images haven't been tried.
` },

  { slug: "import-files", group: "Bring in data", title: "Import files", description: "Import CSV, TSV, JSON, Parquet, Avro, YAML, Excel and XML files into Basalt with a preview first.", body: `
## Import a file

1. Choose **New**, then **File import**.
2. Choose or drop the file. For CSV and TSV, say whether the first row holds headers.
3. In the preview, keep or drop each field, rename it and set its type.
4. Name the import and load it.

The import creates a table and a pipeline, and runs one sync straight away.

## What it accepts

| Format | File types | Largest file |
|---|---|---|
| CSV, TSV | «.csv», «.tsv» | 500 MB |
| JSON, JSON lines | «.json», «.jsonl», «.ndjson» | 500 MB |
| Parquet, Avro | «.parquet», «.avro» | 500 MB |
| YAML | «.yaml», «.yml» | 500 MB |
| Excel | «.xlsx» | 500 MB |
| XML | «.xml» | 100 MB |

## Replace a file with a newer version

Import the updated file and choose **Replace** under **Load as**. This is chosen for you when the file has the same name as an earlier import. Rows are replaced, personal data rules stay, and models and dashboards keep working if the fields stay the same. You're told about any field that's gone.

## CSV files that aren't tidy

- Commas or semicolons as separators are both found automatically, as are tabs.
- Numbers like «10,50» and dates like «31/01/2026» are converted when the format is clear, and the type shows in the preview so you can change it. «1,234» and «01/05/2026» could mean two things, so these stay as text unless you choose a type.
- UTF-8, UTF-16 and Windows-1252 text are read, and the preview says when it wasn't UTF-8. Other encodings can come out wrong, so check the sample values, or save the file as UTF-8.
- A row with too few values gets empty ones. A row with too many adds a column, which you can see in the preview and leave out.

## When values don't fit

- A value that doesn't fit the chosen type is left empty, and you're told how many.
- A malformed JSON line stops the import and names the line, so no rows are skipped silently.
- Field names need letters, numbers and underscores, and can't start with a number.

For objects and lists inside a value, see [Semi-structured data](/docs/semi-structured-data).
` },

  { slug: "semi-structured-data", group: "Bring in data", title: "Semi-structured data", description: "How Basalt keeps and queries JSON, XML, struct, list and map columns.", body: `
JSON, XML, Parquet, Avro and YAML can hold objects and lists inside a value. So can «json», «jsonb» and array columns in PostgreSQL, and «json» columns in MySQL. These stay as real JSON, STRUCT, LIST or MAP columns.

## Working with nested values

| Where | What you do |
|---|---|
| Import preview | Keep as JSON, or flatten into columns such as «ship_state». Lists stay together as one JSON column |
| Tables | Click a nested value to read all of it |
| Query editor | Extract a JSON field, and turn an array into rows |
| SQL | Use DuckDB's JSON operators, as in the example below |

~~~
SELECT doc->>'$.customer.city' AS city
FROM raw_app.orders
~~~

## XML

- Each row is an item of the repeating element that holds most of the document.
- Attributes become fields, namespace prefixes join the name, as in «ns_email», and CDATA is read as text.
- In mixed content, text is kept in a «value» field, but not its place among the child elements.
- A DOCTYPE that declares entities is refused, and so is a file nested more than 100 levels deep.

## Personal data in nested values

Every field name and value in a nested column is checked, on every row of each full or incremental sync. If one holds personal data, the whole column is held back until you choose a rule.

A rule applies to the whole column, not to one field inside it. To keep the other fields, flatten the column on import, or leave it out and read the fields you need at the source. Choosing **Keep as is** turns off this check for that column.

On real-time sync, a value in a column with no rule that holds personal data is left empty and reported on the pipeline. Tables synced before this check existed keep their text columns until you run a full refresh.

BigQuery and Snowflake nested columns arrive as text, except JSON columns.
` },

  { slug: "pipelines", group: "Bring in data", title: "Pipelines", description: "Choose tables, sync modes, schedules, retries and stale data alerts for a Basalt pipeline.", body: `
Each connection has a pipeline, which copies the tables you choose.

## Set up a pipeline

1. Open it from **Pipelines**.
2. Tick the tables to sync.
3. Choose a sync mode for each table, and its cursor column and primary key if the mode needs them.
4. Set **Schedule**, **After a sync**, **If a sync fails** and **Alert if data is older than**.
5. Run it, and read the result in **Run history**.

## Sync modes

| Mode | What happens | You need |
|---|---|---|
| Full refresh: replace the copy | Replaces the copy each time | Nothing |
| Incremental: add new rows | Adds rows newer than the last sync | A cursor column |
| Incremental: add and update by key | Adds new rows and updates changed ones | A cursor column and a primary key |

Without a cursor column, an incremental table reads every row on each sync, and the page warns you.

## Other settings

| Setting | Choices |
|---|---|
| After a sync | Rebuild models, or do nothing |
| If a sync fails | Don't retry, retry once, or retry 3 times. Retries wait 5 minutes |
| Alert if data is older than | Never, 1 hour, 6 hours, 1 day or 3 days |
| Status | Active or paused |

## Checks on every sync

Each sync compares row counts with the source, except for Airbyte streams. A new source column that looks like personal data is held back rather than copied. A column removed from the source stays in the copy and fills with empty values.
` },

  { slug: "real-time", group: "Bring in data", title: "Real-time data", description: "Real-time sync from PostgreSQL, event streams over HTTP, and dashboards that refresh when data changes.", body: `
Basalt has three real-time features. Real-time sync follows a PostgreSQL database. Event streams take events from your applications. Dashboards and data views refresh when either one changes a table they read.

## Real-time sync from PostgreSQL

Inserts, updates and deletes arrive within seconds, through a small worker program that reads PostgreSQL's replication log.

1. On your PostgreSQL server, set «wal_level=logical» and create a login with the «REPLICATION» role.
2. Check that each table is ticked on the pipeline and has a primary key, with no masking rule on that key.
3. On the pipeline, an admin chooses **Turn on real-time sync**. The worker's settings appear, including a token that's shown only once. **Get a new worker token** replaces it.
4. Give the settings to whoever runs the worker for your workspace.
5. Once the worker has started, run one full sync.

The pipeline then shows the worker's status, its last check-in and the number of changes applied. Basalt raises an alert after 10 minutes without a check-in. While the worker is stopped, PostgreSQL keeps changes for it, which uses disk on that database. The worker catches up from where it stopped.

Tick **Rebuild incremental models that read these tables** to rebuild them, at most once a minute.

### What to expect

- PostgreSQL is the only source. There's no real-time sync for MySQL, MariaDB or Airbyte.
- While a sync of the pipeline runs, changes wait until it finishes.
- A table with no primary key, or with a masked one, is skipped and listed on the pipeline.
- A new column in the source isn't copied until a sync runs, and the pipeline says so.
- A row deleted in the source stays in an incremental copy. To find these rows, set **Rows deleted in the source** to mark them in a «_basalt_deleted» column in the pipeline's settings, then filter on it in a model. A full refresh removes them anyway.
- A column with no rule that looks like personal data arrives empty until you choose a rule.
- Real-time sync doesn't send [OpenLineage](/docs/openlineage) events.

## Event streams

An event stream gives an application or webhook an address to send JSON to.

1. Go to **Connections**. Under **Event streams**, choose **Add stream**.
2. Name it, such as «web_events». Optionally set a unique field, so a later event with the same value replaces the earlier one.
3. Copy the token. It's shown only once.
4. Send events.

~~~
curl -X POST https://your-workspace/api/ingest/web_events \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Idempotency-Key: first-batch" \\
  -H "Content-Type: application/json" \\
  -d '[{"id": 1, "kind": "signup"}]'
~~~

Events land in the table «raw_events.web_events». A model reads it with «{{ source('events', 'web_events') }}».

| Item | Detail |
|---|---|
| Body | One JSON object, an array of objects, or one object per line |
| Largest request | 10 MB and 50,000 events |
| Rate | 200 requests a second for each stream |
| Columns | Up to 300. Names become lowercase with underscores, and names starting «basalt_» are refused |
| Nested objects | Become columns such as «customer_email», up to 5 levels. Lists stay as one JSON column |
| Token | Opens one stream and can only add to it. A webhook sender that can't set a header can use «?token=» |

A success reply means the events are stored, so if you get an error or no reply, send them again. Resending with the same «Idempotency-Key» within 24 hours doesn't add them twice.

Open a stream to set a rule for each field, replace the token, or rebuild incremental models that read it. A field that looks like personal data is held back until you choose a rule, and values sent before then aren't kept. Only admins can remove a stream, which deletes its table.

## Live dashboards and data views

When real-time sync or an event stream changes a table that an open dashboard or data view reads, directly or through a view, the page refreshes. It refreshes at most every 3 seconds, and a tab in the background waits until you return to it.

A badge shows **Live**, **Connecting**, **Reconnecting**, **Not live** or **Paused**, next to the time of the last update. Use **Pause** to hold the page still, and **Resume** to catch up. Your row rules still apply to every refresh.
` },

  { slug: "personal-data", group: "Bring in data", title: "Personal data", description: "How Basalt finds personal data, holds it back, and the masking rules you can apply to each column.", body: `
Basalt checks source columns for personal data. A flagged column is held back from the warehouse until someone chooses a rule, so nothing sensitive is copied by accident.

## Choose rules

1. Go to **Personal data**. Each source lists its flagged columns, with what was found.
2. Choose a rule for each column.
3. Run a sync.

A rule applies from the next sync. Run a full refresh to rewrite what's already copied.

## Rules

| Rule | Result | Example |
|---|---|---|
| Mask characters | Keeps the first 2 and last 2 characters. A value of 4 characters or fewer is fully masked | «Jordan» becomes «Jo••an» |
| Replace with a code | The same value always gets the same code, so joins still work | «id_» followed by 12 characters |
| Round date to month | Dates become the first of the month | «1990-06-14» becomes «1990-06-01» |
| Leave out | The column isn't copied | None |
| Keep as is | The value is copied unchanged | None |

## What gets flagged

| Found by column name | Also found by sampled values |
|---|---|
| Government IDs, such as SSN, EIN or passport | Yes, «123-45-6789» patterns |
| Financial accounts, such as bank account, routing or card numbers | Yes, 16-digit card patterns |
| Email addresses | Yes |
| Phone numbers | Yes, US formats |
| Postal addresses | No |
| Person names | No |
| Dates of birth | No |
| IP addresses | No |
| Credentials, such as passwords, tokens and API keys | No |

## Limits

The checks can miss personal data, such as a name inside free-text notes, so review your columns. Personal data rules don't apply to [seeds](/docs/dbt) or to [bases](/docs/bases).
` },

  { slug: "etl-flow", group: "Transform", title: "ETL flow", description: "See extract, transform and deliver on one page, run everything, and schedule model builds.", body: `
**ETL flow** shows the whole path on one graph: sources, models, dashboards and exports.

## Run everything

**Run everything** syncs each active pipeline, then builds models. If a sync fails, models don't build on incomplete data.

## Controls

| Control | Where | What it does |
|---|---|---|
| Build all models | ETL flow | Rebuilds models on a schedule |
| Build a model and what depends on it | Select a model in the graph | Rebuilds it and everything built from it |
| If a sync fails | Pipeline | Retries after 5 minutes, as many times as you choose |
| Alert if data is older than | Pipeline | Raises an alert when the last good sync is too old |
| Blocking | A model's check | Stops dependent models from building if the check fails |
| Repeat | Export dialog in the catalog | Sends a table to a bucket or warehouse on a schedule |
` },

  { slug: "models", group: "Transform", title: "Models", description: "Build clean tables in Basalt with SQL, the query editor, Python or a CSV seed, and add data checks.", body: `
Models turn raw copies into clean tables. Basalt builds them in dependency order and shows the lineage.

## Create a model

1. Go to **Models** and choose **New model**.
2. Name it, and choose SQL, Query editor, Python or Seed (CSV).
3. Write it, and check the preview.
4. Choose how to build it.
5. Choose **Build all**, or **Build selection** for part of the project.

~~~
SELECT o.id, o.amount, c.region
FROM {{ source('app', 'orders') }} o
JOIN {{ ref('stg_customers') }} c ON c.id = o.customer_id
~~~

Use «{{ ref('model_name') }}» for another model and «{{ source('connection', 'table') }}» for a synced table. Only admins can change Python code.

A Python model defines «model(dbt, session)» and returns rows. «dbt.ref('name')» and «dbt.source('connection', 'table')» read other tables as lists of rows, and Basalt adds them to the model's inputs, so it builds in the right order and appears in lineage. «session» is empty, because the code runs on this server rather than on a warehouse. Models that use the older «transform(tables)» keep working.

## How to build it

| Build as | Use it when |
|---|---|
| View | The query is quick, and you want the latest data |
| Table | The query is slow or used a lot |
| Incremental | The table is large. Only new or changed rows are processed. Needs a cursor column, and a unique key to update rows. A row older than the newest one already loaded is missed unless you set **Late rows: days**, which reads that many days back on each build and needs a unique key |
| Snapshot | You need to see how rows changed over time. Adds «_valid_from» and «_valid_to», or dbt's columns with a strategy |
| Ephemeral | Other models use the query, and nothing needs to be stored |

## Data checks

Add checks to a model: not empty, unique, allowed values, exists in another model, within a range, row count, updated recently, or custom SQL that should find no rows. A failed check is reported on the run and doesn't remove the data. Mark a check as blocking to stop the models that depend on it.

## Alerts

In **Settings**, under **Alerts**, choose what raises an alert and add a webhook, such as Slack or Teams. A problem that continues repeats at most once an hour, and you get a message when it's resolved.
` },

  { slug: "dbt", group: "Transform", title: "dbt features", description: "The dbt features Basalt supports: Jinja templates, selection, seeds, incremental strategies, snapshots, contracts and more.", body: `
These work in Basalt with no extra tool. They use a safe subset of Jinja that can't run code.

## Templates

~~~
{{ config(materialized='table') }}
SELECT *, {{ var('tax_rate', '0.08') }} * amount AS tax
FROM {{ ref('stg_orders') }}
{% if is_incremental() %}
WHERE updated_at > (SELECT max(updated_at) FROM {{ this }})
{% endif %}
~~~

Also available: «source», macros, if, for and set.

## Features

| Feature | Where |
|---|---|
| Variables and macros | Models, Project |
| Selection | **Build selection** takes «+m», «m+», «2+m», «@m», «tag:x», «source:app+», «exposure:x», «resource_type:seed» and «config.materialized:table». A space means either and a comma means both. There's also an exclude |
| Seeds | **New model**, then **Seed (CSV)**, up to 1 MB. Personal data rules don't apply, and viewers can read the table through SQL |
| Incremental | On a model's settings: append, merge or delete+insert, and on_schema_change |
| Snapshots | On a model's settings: timestamp or check, which add «dbt_valid_from», «dbt_valid_to», «dbt_updated_at» and «dbt_scd_id». A snapshot with no strategy can't be changed to one on the same table |
| Ephemeral | Build as ephemeral. It isn't stored, and Python models can't read one |
| Checks | Severity, fail if, warn if and only rows where. A test macro is written as «{% test name(model, column_name) %}» |
| Store failures | Keeps failing rows in «analytics_dbt_test__audit». Only editors and admins can read them |
| Contracts | On a model's settings, list every column with its type, and any not null, unique or primary key. A mismatch stops the build |
| Hooks | On a model's settings. One statement per line, in the same transaction as the build, so a failed hook keeps the old table |
| Source freshness | Models, Project, Sources. Checked hourly, and it raises an alert |
| Exposures | Models, Project, Exposures |
| Docs | Models, Project, Docs. Download «manifest.json» and «catalog.json». Each build also saves «manifest.json» and «run_results.json» on the run |

## When dbt itself does the building

Some workspaces have real dbt available, in which case it builds the project.

- The warehouse closes during a dbt run, so syncs, dashboards and queries wait until it finishes. Schedule large builds for quiet times.
- A run stops after 30 minutes by default.
- Editors still can't run Jinja, because Basalt expands templates first. Only admins can turn on full Jinja for a model or add dbt macros.
- Python models and snapshots with no strategy can't run in dbt. A project with any of them uses the built-in builder, and the run says so.

## Not built

Packages, the semantic layer, unit tests, versioned models and microbatch aren't built. Neither are hard deletes with new_record.
` },

  { slug: "power-query-editor", group: "Transform", title: "Power Query editor", description: "Shape data with applied steps in Basalt's query editor, and how it differs from Power Query.", body: `
The query editor shapes data with no code, in steps. Each step compiles to SQL and runs in the warehouse. The browser gets only the first 100 rows at the selected step, plus counts. The output builds as a normal model.

## Build a query

1. Choose **New model**, then **Query editor**.
2. Choose a table.
3. Choose **Add a step**, and fill it in.
4. Rename, reorder, turn off, edit or delete steps under applied steps.
5. Read the **Columns** tab for each column's type, its valid, error and empty share, and its unique count across all rows at that step. Choose a column to see its 10 most common values.
6. Build the model. The **SQL** tab shows the generated SQL, read-only.

## Steps

${ADD_STEPS.map((t) => STEP_LABELS[t]).join(", ")}.

## Custom columns

A custom column uses the same formula syntax as bases, with columns in braces. It can't contain SQL. Dividing by zero leaves the cell empty.

~~~
IF({amount} > 100, "Large", "Small")
~~~

Functions: ${list(CUSTOM_FUNCTIONS)}.

## Parameters

Parameters belong to one query. Type «@name» as a whole value, or use «PARAM("name")» in a custom column. Number and date filter boxes accept only numbers and dates, so «@name» can't be typed there.

## Calculate across rows

**Calculate across rows** adds a column worked out from other rows: rank, row number, previous or next value, change and % change from the previous row, running total, running average, moving average and % of total.

Choose **Start again for each** to work within each customer or month, say, and an order for the rows. Values that aren't numbers count as empty rather than stopping the build.

**Remove duplicates** can keep a chosen row: set the order to newest first to keep each customer's latest. **Split a column into rows** turns «red;blue» into one row each, and keeps rows with nothing to split. Neither an ordered duplicate removal nor these two steps can be shown in the **Advanced editor** yet, which says so rather than losing them.

## Advanced editor

**Advanced editor** shows the query's steps as Power Query M, and M you write or paste becomes steps. A query starts from «Basalt.Table("model:orders")» or «Basalt.Table("source:shop.orders")», and each step starts from the one before. Name any other table you join or stack the same way, such as «Cities = Basalt.Table("model:cities")».

Unpivot, pivot and fill work too. «Table.Pivot» needs its new columns listed, such as «{"Oslo", "Rome"}», because a model's columns have to be known before it runs, so replace any «List.Distinct» you paste.

| M | Step |
| --- | --- |
| «Table.SelectColumns», «Table.RemoveColumns», «Table.RenameColumns» | Keep, remove and rename columns |
| «Table.SelectRows» | Filter rows, with comparisons, «null», «Text.Contains» and «Text.StartsWith» |
| «Table.Sort», «Table.Distinct» | Sort, remove duplicates |
| «Table.TransformColumnTypes», «Table.TransformColumns» | Change types, clean text |
| «Table.AddColumn» | Add a custom column |
| «Table.ReplaceValue» | Replace values |
| «Table.Group» | Group, with row counts, distinct counts, sum, average, min, max and median |
| «Table.FirstN», «Table.LastN», «Table.Range» | Keep rows |
| «Table.NestedJoin» then «Table.ExpandTableColumn» | Merge two tables, keeping the columns you list |
| «Table.Combine» | Stack tables |

Anything else gets a message naming it and its line, and nothing changes. If a query has steps M can't express, such as a pivot, you can read the M but not apply it.

## Compared with Power Query

| Area | In Basalt |
|---|---|
| M language | A subset, in the **Advanced editor**. See below. Custom functions and M's own data sources aren't included |
| Errors | Only values a change type step couldn't convert count as errors. Any other failure stops the query and shows a message. Group, pivot, unpivot and transpose end error tracking |
| Transpose, pivot, first row as headers | Names are read when you set the step up, then stored, so they don't follow later data. Transpose handles up to 200 rows, ignores rows beyond the count it stored, and outputs text. Pivot uses up to 100 values |
| Row order | Fill down, keep top and first row as headers use the order of the rows at that step, so sort first when order matters. Remove duplicates keeps an arbitrary row of each set. Turning an array into rows doesn't keep the array's order |
| Replace values | The column becomes text. Add a change type step to turn it back |
| Reference | Reads the built output of the first query, so build that query first |
` },

  { slug: "semantic-model", group: "Model and measure", title: "Semantic model", description: "Relationships, measures, date tables, calculated columns, hierarchies and perspectives in Basalt's semantic model.", body: `
The **Model** tab on **Metrics** holds your workspace's tables, relationships, hierarchies, measures and perspectives. New visuals read their fields from it. Dashboards made without a model keep working as they were.

## Set up a model

1. Go to **Metrics**, then **Model**.
2. Add the warehouse tables you report on.
3. Choose **Add relationship** and connect the tables.
4. Choose **Validate**. It counts repeated keys on the one side and rows with no match.
5. Mark a date table, or add the auto date table, if you need time intelligence.
6. Add measures on the **Metrics** tab, and use one in DAX as «[Name]».

## Reference

| Part | How it works |
|---|---|
| Relationships | Many to one or many to many, active or inactive, single or both directions. Rows with no match show under a blank value, except across many to many |
| Filters | A field from any related table filters a measure through its relationships. A repeated key on the one side stops the query with an error, so a join can't inflate a total |
| Measures | Metrics are the measures. Display folders and KPI targets are set on the metric |
| Calculated columns and tables | Written in DAX, stored as generated models, and rebuilt with every model build. **Build generated tables** runs them now |
| Row rules | Every compiled query goes through the same row rules as any other. A member with row rules can't read a table without the rule's column |
| Data layers | Raw («raw_» schemas and sample), Staging («stg_» models), Analytics (other models) and Model (generated tables). See **Data layers** in the catalog. Admins can close a layer to viewers |

## Limits

- Data categories are stored, but no map visual reads them.
- Row filters are the per-member rules, not model roles.
- Results can differ from Power BI in edge cases, such as week-based periods, text differing only by case in groups, and «x / 0», which is blank rather than infinity.
- Fiscal year ends aren't supported. See the [DAX reference](/docs/dax-reference).
` },

  { slug: "dax-reference", group: "Model and measure", title: "DAX reference", description: "Every DAX function Basalt supports in model and non-model visuals, and what it refuses.", body: `
Basalt turns DAX into SQL. Anything it can't compute exactly is refused by name with a message, rather than guessed.

## Where to write it

In a visual, choose **Custom** under values, then **DAX**. For a measure others can reuse, add a metric. See [Semantic model](/docs/semantic-model).

## Examples

Each line is a formula on its own, for a table named «Orders» and a marked date table «Dates».

~~~
SUM(Orders[amount])

DIVIDE(SUM(Orders[amount]), CALCULATE(SUM(Orders[amount]), ALL(Orders)))

CALCULATE(SUM(Orders[amount]), SAMEPERIODLASTYEAR(Dates[date]))

CALCULATE(SUM(Orders[amount]), TOPN(3, VALUES(Orders[city]), SUM(Orders[amount])))
~~~

## Supported on a model visual

${list(MODEL_DAX_FUNCTIONS)}.

## Supported on a dashboard without a model

This is a smaller DAX, where filters don't cross relationships.

${list(DAX_FUNCTIONS)}.

- Name columns by the visual's table or its short name, such as «Orders» for «fct_orders». Other table names are refused, except through «RELATED» and «USERELATIONSHIP».
- Time intelligence needs a date grouping on the visual, or none at all.
- «TOPN» takes one order and keeps ties, as a «CALCULATE» filter or an iterator's table.
- «SUMMARIZE» is an iterator's table. Iterating groups, including «VALUES», works on single numbers only.
- «EARLIER» works in one iterator nested inside another over the visual's table.
- «USERELATIONSHIP» is a «CALCULATE» filter on a visual of the relationship's from table.

## Refused everywhere

${list(DAX_REFUSED)}.

## Also refused on a dashboard without a model

«ADDCOLUMNS», «SELECTCOLUMNS», «CROSSFILTER», «CALCULATETABLE», «RELATEDTABLE».

## Patterns refused on a model visual

- A filter that can reach a table by more than one path. Make one relationship inactive or single direction.
- Time intelligence on a column that isn't marked as the date table's date.
- Time intelligence with a year-end date.
- «ALLSELECTED» inside an iterator, and «ALL()» or «ALLSELECTED()» with no arguments as a table.
- A whole table as a «CALCULATE» filter. Use «FILTER(Orders, ...)».
- One «CALCULATE» filter across two tables. Use one filter per table.
- A measure or a function's result inside a «CALCULATE» filter. Put the value in a «VAR» first.
- «TOPN» with more than one order, and «CONCATENATEX» with an order.
- «DISTINCT» of a whole table.
- Measures that refer to each other too deeply.
` },

  { slug: "bases", group: "Bases", title: "Bases", description: "Editable, linked tables your team works on together in Basalt, with keyboard editing, comments and history.", body: `
A base holds data your team edits together, such as projects, orders or contacts. Unlike synced copies, records in a base are edited directly.

## Create a base

1. Choose **New**, then **Base**.
2. Add fields. See [Fields and formulas](/docs/base-fields).
3. Type records in, or use the + next to the table names to import a CSV.
4. Open a record to see every field, add comments and read its change history.

A table holds up to 50,000 records.

## Keyboard

| Key | Action |
|---|---|
| Arrow keys, Tab | Move between cells |
| Type, or Enter | Edit the cell |
| Space | Open the record |
| Shift and arrows | Select a range |
| Ctrl C, Ctrl V | Copy and paste, including from a spreadsheet |
| Delete | Clear the selected cells |
| Ctrl Z | Undo |

## Who can do what

Editors and admins can change records. Viewers can read and comment. Viewers with row access rules can't open bases.

## Sync between bases

Use the + next to the table names and choose **Sync from another base**. You get a read-only copy that updates when the original changes, optionally limited to a view. Links and formulas arrive as plain text.

## Use a base in dashboards

Choose **Use in dashboards** at the top of a base. Basalt keeps a copy in the warehouse, in a schema named like «base_your_base», a few seconds after edits stop. Personal data rules don't apply to bases, so take care with what you share this way.

## Extensions and interfaces

**Snapshots** in the base's menu keeps whole copies to go back to. One is taken on the first edit each day, you can take your own, and the latest 30 are kept. Only admins can restore one, which saves the current state first so it can be undone. Deleting a base deletes its snapshots.

**Extensions** has find and replace, find and delete duplicates, and a pivot table that counts records by two fields. Admins can add custom extensions in HTML and JavaScript, which run in a locked frame. Only add code you trust.

Interfaces are simple pages built from a base, with numbers, bar charts and lists of records.

Edits are saved after a short pause, so a failure can lose the last half second.
` },

  { slug: "base-fields", group: "Bases", title: "Fields and formulas", description: "Field types in Basalt bases and the formula functions they support.", body: `
## Field types

| Type | Holds |
|---|---|
| Single line text, Long text | Short or multi-line text |
| Number, Currency, Percent, Duration, Rating | Numbers with the matching format |
| Checkbox | Yes or no |
| Single select, Multiple select | Options from a list, with colors |
| Date | A date, with an optional time |
| Email, URL, Phone number | Contact details you can click |
| User | A person in this workspace |
| Attachment | Files up to 25 MB each |
| Barcode | A code you type or scan. Camera scanning needs a browser with BarcodeDetector, such as Chrome on Android |
| Button | A labelled link built from the record's values |
| Link to another record | Records in another table. The link works both ways |
| Lookup | A field read through a link |
| Rollup | A calculation across linked records |
| Count | How many records are linked |
| Formula | A value worked out from other fields |
| Autonumber, Created time, Last modified time, Created by, Last modified by | Filled in automatically |

## Formulas

Refer to fields in braces. A formula works on one record. To read other records, use a lookup or rollup.

~~~
{Price} * {Quantity}
IF({Status} = "Done", "Finished", "Open")
DATETIME_DIFF({Due}, TODAY(), "days")
UPPER(LEFT({Name}, 1)) & "-" & RECORD_ID()
~~~

Operators: «+», «-», «*», «/», «%», «&», «=», «!=», «>», «<», «>=», «<=».

Functions: ${list(FORMULA_FUNCTIONS)}.

A formula that can't be worked out shows «#ERROR» in that cell only. Hover over it to see why.
` },

  { slug: "base-views", group: "Bases", title: "Views and forms", description: "Grid, kanban, gallery, calendar, timeline and form views in Basalt bases.", body: `
## Views

| View | Best for | Setting |
|---|---|---|
| Grid | Editing many records | Row height, grouping, frozen fields, a summary under each column |
| Kanban | Moving work through stages | A single select field. Drag cards between columns |
| Gallery | Browsing records as cards | An attachment or URL field as the cover |
| Calendar | Dates and deadlines | A date field. Drag records between days |
| Timeline | Work that spans dates | A start date, and optionally an end date |
| Form | Collecting records from others | The fields to ask for |

Each view keeps its own filters, sorting, hidden fields and colors. These never change the records.

Use the three dots next to a view to lock it or make it personal. A locked view can't be changed until someone unlocks it. A personal view is shown only to the person who made it. This keeps the list tidy, and isn't a security control.

## Share a form

1. Create a Form view.
2. Choose its fields, and mark the required ones.
3. Create a shared link.

Anyone with the link can add a record, but can't see existing ones. Turning the link off stops it working straight away. Link and attachment fields can't be used on forms.
` },

  { slug: "base-automations", group: "Bases", title: "Automations", description: "Trigger actions from records, forms, schedules and webhooks in Basalt bases.", body: `
## Create an automation

1. Open **Automations** in a base.
2. Choose a table and a trigger.
3. Add one or more actions.
4. Turn it on. Open it later to see its run history.

## Triggers

- A record is created
- A record is updated
- A record matches conditions
- A form is submitted
- At a scheduled time: every 15 minutes, hour, 6 hours, day or week. The first run is one interval after you turn it on
- A webhook is received. You get a private address. Send it JSON and use «{key}» in actions

## Actions

| Action | Notes |
|---|---|
| Send an alert | Appears under the bell |
| Send an email | Needs the email server in Settings |
| Find records | Then use «{found_count}» and «{found_names}» in later actions |
| Send to a webhook | Such as Slack or Teams |
| Update this record | Changes the record that triggered it |
| Create a record | In a table you choose |
| Run a script | Admins only. Stops after 2 seconds |

Use «{Field name}» in text to include a value.

## What to expect

- A record that already matched when you turned on a "matches conditions" automation only runs it after it stops and starts matching again.
- Changes made by automations don't trigger other automations, so they can't loop.
- A scheduled automation runs once each time, not once per record.
` },

  { slug: "base-api", group: "Bases", title: "Base API", description: "Read and change records in a Basalt base over a REST API with a per-base token.", body: `
Open **API** at the top of a base to create a token. It's shown once. Read tokens can't change anything.

## Requests

| Request | What it does |
|---|---|
| «GET /api/v1/BASE/TABLE» | Lists records. Options: «pageSize» up to 100, «offset», «view», «fields[]» |
| «POST /api/v1/BASE/TABLE» | Creates up to 10 records |
| «PATCH /api/v1/BASE/TABLE» | Updates up to 10 records |
| «DELETE /api/v1/BASE/TABLE?records[]=ID» | Deletes up to 10 records |

«TABLE» can be the table's name or ID. Each token can make 5 requests a second.

## Example

~~~
curl -X POST https://your-workspace/api/v1/BASE/Tasks \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{ "records": [{ "fields": { "Name": "Call the supplier", "Status": "To do" } }] }'
~~~

A list reply has «records», and «offset» when there are more. Pass it back to get the next page.
` },

  { slug: "notebooks", group: "Explore and report", title: "Notebooks", description: "Mix SQL, Python and notes on one page, see results as tables and charts, and run them on a schedule.", body: `
A notebook is a page of cells that run from top to bottom. Open it from **Notebooks** in the sidebar.

## Cells

- **SQL** queries the warehouse, with the same access rules as the SQL editor.
- **Python** runs code with the Python installed on this server. Only admins can edit or run it. The page says whether Python was found, and how to add it if not.
- **Text** holds notes for whoever reads the notebook next.

Choose **Run** on a cell, or **Run all** to run every cell in order. A failed cell stops the cells after it.

## Using an earlier result in Python

Each cell has a name such as «cell1». Python reads earlier results from «results» as a list of rows, and «display(rows)» shows rows in the same table and chart as SQL. For example, «display(results['cell1'])» shows the first cell's rows again.

Variables, functions, classes and imports carry from one Python cell to the next. Each cell runs in its own process, so they're saved and restored between cells, and a value that can't be saved, such as an open file, is named under the cell. **Run all** starts clean, and **Clear variables and results** in the menu does the same by hand.

## Standard analyses

A new notebook can start from a template. Choose the table and which columns to use, and Basalt writes the cells:

| Template | What it answers |
| --- | --- |
| Explore a table | What's in this table? |
| Data quality audit | Are there duplicates, missing keys or impossible dates? |
| Cohort retention | Do people who started in a month come back? |
| Conversion funnel | Where do people drop off? |
| Customer segments (RFM) | Who are our best and lost customers? |
| Trend over time | Is it growing, and where is it heading? |
| A/B test | Is the difference between two variants real? |
| What changed? | Which group explains last month's change? |
| Reconcile two tables | Where do two sources of a number disagree? |

## Schedules

Choose a schedule at the top of the notebook. Each run appears in run history, and a failure raises an alert. Viewers can't open notebooks.
` },

  { slug: "data-views-and-catalog", group: "Explore and report", title: "Data views and catalog", description: "Browse warehouse tables as grids, boards and pivots, profile columns in the catalog, and export data.", body: `
## Data views

Open a column's menu and use **Show as** to choose how its values look: currency, percent, short numbers such as 1.2M, dates such as Oct 2026 or time ago, upper or title case, web and email links, or a check mark. This changes only the display, so filters, sorting and exports keep using the real value.

Data views show warehouse tables as a grid, board, gallery or pivot. Filter by value, sort, group, color cells or rows by rule, rename fields and freeze columns. Save the result as a view for everyone. Warehouse tables are read-only here. To edit data, use a [base](/docs/bases).

## Data catalog

The catalog lists every table with its columns, empty values, unique counts, ranges and lineage.

## Export data

1. Open a table in the catalog and choose **Export**. Editors and admins only.
2. Choose a download, a bucket, or a table in BigQuery or Snowflake.
3. Choose a format: Parquet, CSV, JSON, Excel, XML or Delta table. A Delta table is a folder, and each export replaces its contents as a new version, so earlier versions stay readable.
4. Optionally set it to repeat.

An existing file or table with that name is replaced. Masked fields stay masked. Delta Lake can't be written.
` },

  { slug: "dashboards", group: "Explore and report", title: "Dashboards", description: "Create dashboards with visuals, slicers, drill-through, report pages, bookmarks and subscriptions in Basalt.", body: `
## Create a dashboard

1. Go to **Dashboards** and create one, empty or from a table. From a table, Basalt adds headline numbers, a trend and breakdowns for you to change.
2. In edit mode, add a visual and choose its fields.
3. Drag a tile by its title, or resize it from the corner. Other tiles move out of the way.
4. Add pages with the tabs under the dashboard.

## Visuals

Matrix, decomposition tree, number, column, bar, stacked column, line, area, column and line, pie, donut, treemap, funnel, gauge, heatmap, scatter, waterfall, table, slicer and text.

## Filter and explore

| Feature | How to use it |
|---|---|
| Slicers and cross-filtering | Clicking a value filters the other visuals. Slicers apply to their own page |
| Drill-through | Set a visual to open the rows behind a value, or another dashboard |
| Drill down | In a visual's settings, add fields under **Drill down**. Click a value to go deeper, and use **Up** to return |
| Decomposition tree | Tick fields under **Drill down**. Click a bar to split it further |
| Bookmarks | Save the current page, slicers and drill position |
| Ask | Type a question, such as "total amount by city". It matches your words to table and field names, with no AI service, and tells you when it can't find a match |

## Calculate

| Feature | How to use it |
|---|---|
| Custom measures | Choose **Custom** under values and write a SQL aggregate, such as «SUM(price) - SUM(cost)», or [DAX](/docs/dax-reference) |
| What-if parameters | Add a slider, then use «{{name}}» in a custom measure |
| Show value as | Percent of total, running total or change from previous |
| Number trends | Add a date to show a 12-month line and the change against last month |
| Relationships | Under **Model** on a dashboard, connect a field in one table to a field in another. Slicers then filter both |

## Format

Conditional formatting offers a color scale, data bars or rules, on tables, matrices and numbers. **Add to tooltip** adds extra totals. In edit mode, choose a report theme.

## Share

| Feature | How to use it |
|---|---|
| Subscribe | Get a report by email, daily, weekly or every 30 days. Needs an email server in Settings, and shows only what your access allows |
| PDF and PNG | Under the download button. In a PNG, charts are drawn as shown and other tiles as text, without a number's trend line |
| Pin to a dashboard | Three dots on a tile, then **Pin**. The copy keeps its page filters and brings its measures and sliders. A measure of the same name with a different formula stops the pin |
| Comments | Three dots on a tile. Someone limited by row rules sees only their own comments |
| Data alerts | On a number or gauge tile, three dots, then **Alert**. Checked every 15 minutes through your own row rules. It emails you once each time the value crosses your limit, if an email server is set up |
| Tile CSV | Three dots, then **Export** |

On phones, tiles stack in reading order, and editing a dashboard needs a larger screen. There's no custom visuals marketplace or native mobile app. To see dashboards refresh as data changes, see [Real-time data](/docs/real-time).
` },

  { slug: "custom-visuals", group: "Explore and report", title: "Custom visuals", description: "Draw any chart the ECharts library supports on a dashboard by describing it in JSON, with no code to run.", body: `
When the built-in visuals don't fit, a custom visual lets you describe the chart yourself.

1. Edit a dashboard and add a visual.
2. Choose **Custom visual** as the type.
3. Choose the table, **Group by** and values, as for any visual.
4. Pick an example under **Start from**, then change it to suit.

## Writing a spec

A spec is ECharts options written as JSON. Your data is already loaded, so a series points at its columns: «d» is **Group by**, «s» is **Split into series**, and «m0», «m1» are your values in order.

## What's removed

A chart can be seen by anyone with access to the dashboard, so anything that could run code or reach outside Basalt is removed: formatters, HTML, images, links, toolboxes and web addresses. If a spec can't be drawn, the tile says why, and the rest of the dashboard keeps working.
` },

  { slug: "apps", group: "Explore and report", title: "Apps", description: "Package dashboards and links as an app with audiences, versions and rollback in Basalt.", body: `
An app packages dashboards and links under its own name, logo and navigation.

## Publish an app

1. Go to **Apps** and create one.
2. Add pages.
3. Add audiences, and choose which people and pages each one includes.
4. Publish. This freezes a copy of each dashboard.

Edits stay in the draft until you publish again, and the status shows when they differ. Each publish is a version, and the last 25 are kept. Rolling back publishes an old version again and leaves your draft alone.

## Readers

Readers open the app at its own address, with their row rules applied. They can filter, drill, comment and export. Someone outside the audience gets a permission message, and hidden pages are refused.

## Limits

- Editors and admins see every page and every dashboard.
- An audience limits dashboards, not data. A viewer can still query any table in the SQL editor unless a row or table rule stops them.
- Once a dashboard is in a published app, viewers read it only through an app. A tile pinned from it to another dashboard is a separate copy that viewers of that dashboard can see.
- Subscriptions aren't offered inside an app, and existing subscriptions to its dashboards stop for viewers.
` },

  { slug: "sql-commands", group: "Explore and report", title: "SQL commands and access", description: "Which SQL statements each Basalt role can run in the SQL editor, and how GRANT and REVOKE work.", body: `
The **SQL editor** runs DuckDB SQL. Run a query with Ctrl Enter and see results as a table or chart. **Explain** shows the query plan, and queries can be saved.

## What each role can run

| Statements | Viewer | Editor | Admin |
|---|---|---|---|
| SELECT, EXPLAIN | Yes | Yes | Yes |
| INSERT, UPDATE, DELETE, MERGE | No | Yes | Yes |
| CREATE, ALTER, DROP | No | Yes | Yes |
| BEGIN, COMMIT, ROLLBACK | No | Yes | Yes |
| GRANT, REVOKE | No | No | Yes |

Viewers can't use EXPLAIN ANALYZE, because it really runs the statement. Statements of any other kind are refused for everyone.

Several statements run together succeed or fail as one. If you write your own BEGIN, finish it with COMMIT or ROLLBACK, or its changes are undone. Changes to data and structure go in the audit log.

## Grant and revoke

~~~
REVOKE SELECT ON analytics.fct_orders FROM 'person@example.com';
GRANT SELECT ON analytics.fct_orders TO 'person@example.com';
GRANT editor TO 'person@example.com';
REVOKE editor FROM 'person@example.com';
SHOW GRANTS;
~~~

Table access limits viewers only, because editors and admins can change models and data.

It limits the table itself, not copies of its rows. A model, calculated table or generated model that an editor builds on a revoked table is readable by that viewer, because viewers read models by design. To keep rows from someone, also revoke the models built on them, or close the data layer. Stored check failures aren't modelled output, so viewers can never read them.

## What viewers can read

Viewers read under their row rules and table access. JSON functions such as «->>», «json_each» and «json_tree» work for them.
` },

  { slug: "openlineage", group: "Operate", title: "OpenLineage", description: "Read and send OpenLineage run events from Basalt syncs, model builds, flows, notebooks and exports.", body: `
Syncs, model builds, ETL flows, notebooks and exports to a connection save OpenLineage run events, spec 2-0-2.

## Read and send events

1. Open a run in **Run history** and choose **OpenLineage events**.
2. To send them, an admin goes to **Settings**, then **OpenLineage**.
3. Choose **HTTP endpoint**, then enter the address and an API key. An address without a path uses «/api/v1/lineage». The key goes as a bearer token and is stored encrypted.

Internal addresses are refused. Sending never holds up or fails a run.

## Events

| Run | Job name | Events |
|---|---|---|
| Sync | «sync.connection» | START, RUNNING after each table when there are several, COMPLETE or FAIL. A partly failed sync sends FAIL |
| Model build | «models.all» | START, then COMPLETE or FAIL. Any failed step or check sends FAIL |
| One model | «model.name» | START, COMPLETE or FAIL. A model skipped because an upstream model failed sends ABORT |
| A model's checks | «model.name.checks» | START, then COMPLETE or FAIL, with assertions and metrics |
| ETL flow | «flow.all» | START, COMPLETE or FAIL |
| Export | «export.table.connection» | START, COMPLETE or FAIL |
| Notebook | «notebook.name» | START, COMPLETE or FAIL when run as a whole or on a schedule. Lists the tables its SQL cells read and write. What Python cells touch isn't visible |

## Delivery

Up to 500 events wait and retry with growing delays. If more build up, the oldest are dropped. An event the endpoint rejects with status 400, 413 or 422 is dropped. Settings shows what's waiting, what was dropped and the last error.

## What events contain

Events hold names of tables and columns, host and port of sources, row counts and check results. They never hold row values, passwords or keys. Error text is cut to its first line with quoted text removed, and Python model errors aren't sent. SQL text is left out unless you turn it on.

Columns masked by a personal data rule are marked «masking: true» in column lineage. Column lineage for models covers only a single SELECT from named tables and joins.

## Limits

Real-time sync and browser downloads send no events. Sending has been checked against a test receiver, but not against Marquez.
` },

  { slug: "admin", group: "Operate", title: "Admin", description: "Manage members, roles, row access, single sign-on, the audit log and workspace settings in Basalt.", body: `
## Add a member

Go to **Members and audit**, choose **Add member**, and enter a name, email, temporary password and role.

## Session limits

Admins set these under **Members and audit**, then **Sign-in rules**: how long without activity before someone is signed out, and the longest a session can last. Changes apply to people already signed in. Activity means someone using the page, so a page left open doesn't count. Leave the first off for screens that show a dashboard all day.

Signing out ends your session on every device. An admin can also sign out one member, or everyone else.

## Two-factor sign-in

Open **Your account** from your profile menu and choose **Set up**. Scan the code with an authenticator app, enter the code it shows, and save your recovery codes. Each recovery code works once.

An admin can require it for everyone under **Members and audit**, then **Sign-in rules**, after turning it on for their own account. An admin can also reset it for someone who has lost their phone. People using single sign-on follow your provider's rules.

## Roles

| Role | Can do |
|---|---|
| Admin | Everything, including members, single sign-on, removing connections and deleting bases |
| Editor | Connections, pipelines, models, dashboards, bases and any SQL |
| Viewer | Dashboards, data views and read-only SQL. Can read bases and comment |

## Limit which rows a viewer sees

1. In **Members and audit**, find **Limit which rows a viewer can see**.
2. Choose the viewer, a field and the allowed values.

The rule applies across dashboards, data views, exports and SQL. Tables without that field are hidden from them, and they can't open bases. Rules apply to viewers only, because editors and admins can change models and data.

## Single sign-on

1. In **Members and audit**, under **Single sign-on**, enter your OpenID Connect provider's issuer URL, client ID and client secret.
2. Add the redirect address shown there to your provider.
3. Choose the role for new people.
4. Set an allowed email domain. Without one, anyone your provider signs in can join, including someone you removed.

When single sign-on is required, admins keep password access in case the provider is down.

## Settings

| Section | What it holds |
|---|---|
| Workspace | Workspace name |
| Email server | Server, port, user, password and sender, for subscriptions, data alerts and automations |
| Alerts | What raises an alert, and a webhook for them |
| OpenLineage | Where run events go |
| Appearance | Accent color, theme and density |
| Numbers and dates | Currency, number format and time zone |

These apply to everyone in the workspace.
` },

  { slug: "how-basalt-handles-data", group: "Help", title: "How Basalt handles data", description: "How Basalt stores, copies, protects and checks your data, in plain terms.", body: `
- **Columnar storage.** The warehouse stores data by column and compresses it, so totals over millions of rows stay fast.
- **Read-only sources.** Every source session is opened as read-only, and sync reads run in a single consistent snapshot on PostgreSQL.
- **Incremental sync.** A cursor column records how far the last sync got. The next sync reads only newer rows and can update by primary key.
- **Schema changes.** New columns are detected on each sync. Personal data waits for a rule, and other columns are added automatically.
- **Nested data.** JSON, STRUCT, LIST and MAP keep their types through import and sync. Every field inside a column with no rule is checked for personal data on every row before it's stored.
- **Safe XML.** Entity declarations are refused, so entities are never expanded and external files are never read. XML files are limited to 100 MB.
- **Masking before storage.** Raw rows stay in memory. Only the masked result is written to the warehouse file.
- **Dependency order.** Models build in dependency order. If one fails, the models that depend on it are skipped instead of using stale data.
- **Data checks.** Never empty, unique, allowed values, and exists in another model. Failures are reported on the run.
- **Sandboxed SQL.** SQL can't read server files or reach the network, and viewers can only run SELECT.
` },
  { slug: "current-limits", group: "Help", title: "Current limits", description: "What Basalt doesn't do yet, and which connectors haven't been tested against real accounts.", body: `
## Connectors

- No cloud connector has run against a real cloud account yet. BigQuery and Snowflake have been tested only against local test servers, S3 against an emulator, and Azure Blob Storage against the Azurite emulator. Try these on your own account first.
- Google Cloud Storage and MySQL haven't run against a real server.
- ADLS Gen2 is read through its Blob endpoint and hasn't been tested on a real account.
- PostgreSQL certificate checks were tested with test certificates, not on a managed cloud database.
- No native cloud source below has run against a real cloud account. Those marked Preview in the list haven't run on a real engine either.
- DynamoDB ran on the moto emulator, and Cosmos DB on an open-source emulator.
- Redshift (Preview) ran on PostgreSQL, not Redshift. Its SUPER columns have never run.
- Athena (Preview) ran on moto with prepared answers, so its SQL has never been executed.
- Firestore and Spanner (Preview) ran against local test servers that speak their protocols.
- SQL Server, Azure SQL and Synapse (Preview) ran against a local test server that speaks the protocol and doesn't execute SQL. The check of a server's certificate hasn't run.
- MySQL, MariaDB and their RDS, Aurora, Cloud SQL and Azure forms (Preview) have only compiled, including the certificate check.
- SQLite and Databricks aren't available.
- Airbyte connectors have been tested only with Sample Data and PokeAPI. See [Airbyte connectors](/docs/airbyte-connectors).

## Features

- [DAX](/docs/dax-reference) refuses what it can't compute exactly. Ask matches words rather than using AI.
- [dbt](/docs/dbt) packages, the semantic layer, unit tests, versioned models and microbatch aren't built.
- The [Power Query editor](/docs/power-query-editor) understands part of the M language, not all of it.
- There's no mobile app or extension marketplace for bases, and no custom visuals marketplace for dashboards.
` },

  { slug: "troubleshooting", group: "Help", title: "Troubleshooting", description: "What common Basalt messages mean and what to do about them.", body: `
| What you see | What to do |
|---|---|
| Your session has ended | Sign in again. You return to the same page |
| You're offline | Reconnect. New changes won't save until you do |
| This is taking longer than usual | Wait, or check your connection |
| Too many attempts | Wait a few minutes, then sign in again |
| Held back on a column | Choose a rule in [Personal data](/docs/personal-data) |
| Row counts differ | Run a full sync. If it continues, check the cursor column |
| Incremental tables need a cursor column | Choose one on the pipeline. Without it, every row is read on each sync |
| «#ERROR» in a base | Hover over the cell to see why, then fix the formula |
| Real-time sync stopped | Ask whoever runs the worker to restart it. It catches up from where it stopped |
| A sync of this pipeline is running | Real-time changes wait until the sync finishes. Nothing is lost |
| Run a full sync first | The real-time table hasn't been copied yet. Run one full sync |
| The file is larger than the limit | Split it. See [Import files](/docs/import-files) |
| A DAX function isn't supported | See the [DAX reference](/docs/dax-reference) for what works |

Need more help? [Contact us](/sales).
` },
];

export const GROUPS = [...new Set(TOPICS.map((t) => t.group))];
