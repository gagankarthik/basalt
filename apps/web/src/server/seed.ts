import { compileSteps } from "@/lib/transform";
import type { Config, Filter, Model, Pipeline, StreamCfg, Widget } from "@/lib/types";

export const SAMPLE_ID = "sample-northfork";

/** Fictional meal-subscription company. Fixed seed, so every install starts with the same numbers. */
export const SAMPLE_SQL = `
CREATE SCHEMA IF NOT EXISTS sample;
SELECT setseed(0.42);
CREATE OR REPLACE MACRO pick(l) AS l[1 + floor(random() * len(l))::INT];
CREATE OR REPLACE TABLE sample.kitchens AS SELECT * FROM (VALUES
  (1,'Williamsburg','New York',900),(2,'Astoria','New York',650),(3,'Park Slope','New York',500),(4,'Harlem','New York',450),
  (5,'East Austin','Austin',700),(6,'North Loop','Austin',520),(7,'River North','Chicago',480)) t(kitchen_id,name,city,capacity);
CREATE OR REPLACE TABLE sample.customers AS
SELECT i AS customer_id, fn || ' ' || ln AS full_name, pick(['212','312','512','646','718','773']) || '555' || lpad(floor(random()*1e4)::INT::VARCHAR, 4, '0') AS phone,
  CASE WHEN random() < .3 THEN pick(['212','312','512','646','718','773']) || '555' || lpad(floor(random()*1e4)::INT::VARCHAR, 4, '0') END AS alt_phone,
  lower(fn) || '.' || lower(ln) || i || pick(['@gmail.com','@outlook.com','@yahoo.com','@proton.me']) AS email,
  floor(1 + random()*900)::INT || ', ' || pick(['Maple St','Oak Ave','Main St','Lakeview Dr','Park Pl']) AS delivery_address,
  pick(['New York','New York','New York','Austin','Austin','Chicago']) AS city,
  pick(['Lunch only','Dinner only','Lunch + dinner','Lunch + dinner']) AS plan,
  pick(['Student','Professional','Professional','Family','Senior']) AS segment,
  TIMESTAMP '2025-01-01' + to_days(floor(pow(random(), .55) * 660)::INT) + to_minutes(floor(random()*1440)::INT) AS signup_at
FROM (SELECT i, pick(['Emma','Liam','Olivia','Noah','Ava','Ethan','Sophia','Mason','Mia','Lucas','Maya','Diego','Grace','Owen','Zoe','Caleb','Nina','Marcus','Ella','Jordan']) fn,
  pick(['Smith','Johnson','Garcia','Lee','Brown','Davis','Martinez','Wilson','Nguyen','Clark','Lopez','Hall','Young','King','Rivera','Carter']) ln FROM generate_series(1, 6500) g(i));
CREATE OR REPLACE TABLE sample.subscriptions AS
WITH b AS (SELECT c.customer_id, c.plan, c.city, c.signup_at, random() r, random() r2 FROM sample.customers c)
SELECT customer_id AS subscription_id, customer_id, CASE city
    WHEN 'Austin' THEN pick([5,5,6]) WHEN 'Chicago' THEN 7 ELSE pick([1,1,1,2,2,3,3,4]) END AS kitchen_id, plan,
  CASE plan WHEN 'Lunch only' THEN 149 WHEN 'Dinner only' THEN 169 ELSE 269 END AS monthly_price,
  CASE WHEN r < .34 THEN 'cancelled' WHEN r < .38 THEN 'paused' ELSE 'active' END AS status, signup_at AS started_at,
  CASE WHEN r < .34 THEN least(signup_at + to_days(20 + floor(r2*300)::INT), TIMESTAMP '2026-10-29') END AS cancelled_at,
  CASE WHEN r < .34 THEN pick(['Too expensive','Too expensive','Too expensive','Moved out of delivery area','Moved out of delivery area','Food quality','Late delivery','Other']) END AS cancel_reason
FROM b;
CREATE OR REPLACE TABLE sample.orders AS
SELECT row_number() OVER () AS order_id, customer_id, kitchen_id, pick(['Lunch','Dinner']) AS meal, round(monthly_price/24.0, 2) AS amount,
  CASE WHEN random() < .025 THEN 'cancelled' WHEN random() < .01 THEN 'refunded' ELSE 'delivered' END AS status,
  started_at + to_days(d) + to_minutes(690 + floor(random()*180)::INT) AS ordered_at, floor(18 + random()*random()*70)::INT AS delivery_minutes,
  CASE WHEN random() < .45 THEN greatest(1, least(5, floor(5.6 - random()*random()*5)::INT)) END AS rating,
  started_at + to_days(d) + to_minutes(690) AS updated_at
FROM (SELECT *, unnest(range(0, greatest(1, date_diff('day', started_at, coalesce(cancelled_at, TIMESTAMP '2026-10-29'))), 9)) AS d FROM sample.subscriptions);
CREATE OR REPLACE TABLE sample.payments AS
SELECT row_number() OVER () AS payment_id, customer_id, subscription_id, monthly_price AS amount, pick(['Credit card','Credit card','Credit card','Debit card','ACH','Apple Pay']) AS method,
  lpad((10000 + customer_id)::VARCHAR, 5, '0') AS billing_zip,
  CASE WHEN random() < .028 THEN 'failed' WHEN random() < .006 THEN 'refunded' ELSE 'paid' END AS status, started_at + to_days(d) AS paid_at
FROM (SELECT *, unnest(range(0, greatest(1, date_diff('day', started_at, coalesce(cancelled_at, TIMESTAMP '2026-10-29'))), 30)) AS d FROM sample.subscriptions);
CREATE OR REPLACE TABLE sample.tickets AS
SELECT i AS ticket_id, 1 + floor(random()*6500)::INT AS customer_id, pick(['Late delivery','Late delivery','Wrong item','Food quality','Billing','Pause request','App issue']) AS category,
  pick(['Low','Normal','Normal','Normal','High','Urgent']) AS priority, CASE WHEN c < TIMESTAMP '2026-10-20' OR random() < .6 THEN 'resolved' ELSE pick(['open','open','waiting']) END AS status,
  c AS created_at, c + to_minutes(floor(30 + random()*random()*4000)::INT) AS resolved_at, CASE WHEN random() < .4 THEN 1 + floor(random()*random()*5)::INT END AS csat
FROM (SELECT i, TIMESTAMP '2025-02-01' + to_days(floor(pow(random(), .6) * 635)::INT) + to_minutes(floor(random()*1440)::INT) AS c FROM generate_series(1, 9500) g(i));
CREATE OR REPLACE TABLE sample.delivery_partners AS
SELECT i AS partner_id, pick(['Carlos','James','Tanya','Andre','Luis','Kevin','Rosa','Sam']) || ' ' || pick(['Reyes','Moore','Scott','Hill','Ward']) AS full_name,
  pick(['212','312','512']) || '555' || lpad(floor(random()*1e4)::INT::VARCHAR, 4, '0') AS phone, lpad(floor(random()*1e12)::BIGINT::VARCHAR, 14, '5') AS bank_account,
  1 + floor(random()*7)::INT AS kitchen_id, TIMESTAMP '2025-01-15' + to_days(floor(random()*600)::INT) AS joined_at
FROM generate_series(1, 148) g(i);
`;

const stream = (name: string, primaryKey: string, cursor: string | undefined, rules: StreamCfg["rules"] = {}): StreamCfg =>
  ({ name, enabled: true, mode: cursor ? "incremental_dedupe" : "full_refresh", primaryKey, cursor, rules });

const samplePipeline: Pipeline = {
  id: "pl-northfork", name: "Northfork Meals production to warehouse", connectionId: SAMPLE_ID, schedule: 0, runModelsAfter: true, paused: false,
  streams: [
    // alt_phone and bank_account deliberately have no rule: they show how a personal data column is held back
    stream("customers", "customer_id", undefined, { full_name: "mask", phone: "mask", email: "hash", delivery_address: "drop" }),
    stream("kitchens", "kitchen_id", undefined),
    stream("subscriptions", "subscription_id", undefined),
    stream("orders", "order_id", "updated_at"),
    stream("payments", "payment_id", "paid_at", { billing_zip: "drop" }),
    stream("tickets", "ticket_id", "created_at"),
    stream("delivery_partners", "partner_id", undefined, { full_name: "mask", phone: "mask" }),
  ],
};

const m = (name: string, description: string, materialized: Model["materialized"], sql: string, tests: Model["tests"] = []): Model =>
  ({ id: name, name, description, materialized, sql: sql.trim(), tests, owner: "Data team" });

const sampleModels: Model[] = [
  m("stg_customers", "One row per customer with personal data already protected.", "view", `SELECT customer_id, full_name, email, city, plan, segment, signup_at\nFROM {{ source('northfork', 'customers') }}`, [{ type: "unique", column: "customer_id" }, { type: "not_null", column: "customer_id" }]),
  m("stg_kitchens", "Kitchen locations and daily capacity.", "view", `SELECT kitchen_id, name AS kitchen, city, capacity\nFROM {{ source('northfork', 'kitchens') }}`, [{ type: "unique", column: "kitchen_id" }]),
  m("stg_subscriptions", "One row per subscription, with its status and any cancellation.", "view", `SELECT subscription_id, customer_id, kitchen_id, plan, monthly_price, status,\n       started_at, cancelled_at, cancel_reason\nFROM {{ source('northfork', 'subscriptions') }}`, [{ type: "unique", column: "subscription_id" }, { type: "accepted_values", column: "status", values: ["active", "paused", "cancelled"] }]),
  m("stg_orders", "One row per meal order.", "view", `SELECT order_id, customer_id, kitchen_id, meal, amount, status, ordered_at, delivery_minutes, rating\nFROM {{ source('northfork', 'orders') }}`, [{ type: "unique", column: "order_id" }, { type: "not_null", column: "kitchen_id" }]),
  m("stg_payments", "One row per payment attempt.", "view", `SELECT payment_id, customer_id, subscription_id, amount, method, status, paid_at\nFROM {{ source('northfork', 'payments') }}`, [{ type: "unique", column: "payment_id" }, { type: "accepted_values", column: "status", values: ["paid", "failed", "refunded"] }]),
  m("stg_tickets", "One row per support ticket.", "view", `SELECT ticket_id, customer_id, category, priority, status, created_at,\n       date_diff('minute', created_at, resolved_at) / 60.0 AS hours_to_resolve, csat\nFROM {{ source('northfork', 'tickets') }}`, [{ type: "unique", column: "ticket_id" }]),
  m("dim_customers", "Customers with lifetime value and current subscription.", "table", `SELECT c.*, s.status AS subscription_status, s.monthly_price, k.kitchen,\n       coalesce(p.lifetime_value, 0) AS lifetime_value\nFROM {{ ref('stg_customers') }} c\nLEFT JOIN {{ ref('stg_subscriptions') }} s USING (customer_id)\nLEFT JOIN {{ ref('stg_kitchens') }} k USING (kitchen_id)\nLEFT JOIN (SELECT customer_id, sum(amount) AS lifetime_value FROM {{ ref('stg_payments') }} WHERE status = 'paid' GROUP BY 1) p USING (customer_id)`, [{ type: "unique", column: "customer_id" }]),
  m("fct_orders", "Orders with kitchen details and a late-delivery flag (over 45 minutes).", "table", `SELECT o.*, k.kitchen, k.city, delivery_minutes > 45 AS is_late\nFROM {{ ref('stg_orders') }} o\nLEFT JOIN {{ ref('stg_kitchens') }} k USING (kitchen_id)`, [{ type: "unique", column: "order_id" }, { type: "relationships", column: "kitchen_id", to: "stg_kitchens", field: "kitchen_id" }]),
  m("fct_payments", "Payments with kitchen and plan for revenue reporting.", "table", `SELECT p.*, s.plan, k.kitchen, k.city\nFROM {{ ref('stg_payments') }} p\nLEFT JOIN {{ ref('stg_subscriptions') }} s USING (subscription_id)\nLEFT JOIN {{ ref('stg_kitchens') }} k USING (kitchen_id)`, [{ type: "unique", column: "payment_id" }]),
  m("fct_subscriptions", "Subscriptions with kitchen, for churn analysis.", "table", `SELECT s.*, k.kitchen, k.city\nFROM {{ ref('stg_subscriptions') }} s\nLEFT JOIN {{ ref('stg_kitchens') }} k USING (kitchen_id)`),
  m("mart_monthly_revenue", "Collected revenue and paying customers by month.", "table", `SELECT date_trunc('month', paid_at)::DATE AS month, sum(amount) AS revenue,\n       count(DISTINCT customer_id) AS paying_customers, count(*) AS payments\nFROM {{ ref('fct_payments') }}\nWHERE status = 'paid'\nGROUP BY 1\nORDER BY 1`, [{ type: "unique", column: "month" }]),
  { ...m("mart_customer_value", "Yearly subscription value by kitchen. Built with no-code steps.", "table", ""), kind: "steps", base: "model:dim_customers",
    steps: [
      { id: "a", type: "filter", filter: { id: "f", column: "subscription_status", op: "eq", value: "active" } },
      { id: "b", type: "calculate", to: "yearly_value", expr: "monthly_price * 12" },
      { id: "c", type: "group", columns: ["kitchen"], aggs: [{ column: "customer_id", agg: "count", as: "active_customers" }, { column: "yearly_value", agg: "sum", as: "yearly_value" }] },
    ],
    sql: compileSteps("model:dim_customers", [
      { id: "a", type: "filter", filter: { id: "f", column: "subscription_status", op: "eq", value: "active" } },
      { id: "b", type: "calculate", to: "yearly_value", expr: "monthly_price * 12" },
      { id: "c", type: "group", columns: ["kitchen"], aggs: [{ column: "customer_id", agg: "count", as: "active_customers" }, { column: "yearly_value", agg: "sum", as: "yearly_value" }] },
    ]) },
  m("mart_kitchen_performance", "Delivery quality and volume for each kitchen.", "table", `SELECT kitchen, city, count(*) AS orders, avg(delivery_minutes) AS avg_delivery_minutes,\n       avg(rating) AS avg_rating, avg(is_late::INT) * 100 AS late_pct, sum(amount) AS order_value\nFROM {{ ref('fct_orders') }}\nGROUP BY 1, 2`, [{ type: "unique", column: "kitchen" }]),
];

const w = (id: string, title: string, type: Widget["type"], x: number, y: number, ww: number, h: number, table: string, measures: Widget["measures"], rest: Partial<Widget> = {}): Widget =>
  ({ id, title, type, x, y, w: ww, h, table, measures, filters: [], showLegend: true, ...rest });
const PAY = "analytics.fct_payments", ORD = "analytics.fct_orders", SUB = "analytics.fct_subscriptions", MK = "analytics.mart_kitchen_performance";
const paid: Filter[] = [{ id: "paid", column: "status", op: "eq", value: "paid" }];
const active: Filter[] = [{ id: "act", column: "status", op: "eq", value: "active" }];
const cancelled: Filter[] = [{ id: "can", column: "status", op: "eq", value: "cancelled" }];

export function defaultConfig(): Config {
  return {
    connections: [], pipelines: [], models: [], views: [], dashboards: [], metrics: [], queries: [],
    settings: { workspace: "My workspace", accent: "#4124fb", theme: "system", density: "compact", currency: "USD", locale: "en-US", timezone: "America/New_York" },
  };
}

export function sampleConfig(): Partial<Config> {
  const now = new Date().toISOString();
  return {
    connections: [{ id: SAMPLE_ID, name: "Northfork Meals production (sample)", type: "sample", slug: "northfork", createdAt: now }],
    pipelines: [samplePipeline],
    models: sampleModels,
    views: [
      { id: "v-orders", name: "All orders", table: ORD, layout: "grid", filters: [], match: "all", sorts: [{ column: "ordered_at", dir: "desc" }], hidden: [], widths: {}, frozen: 1, density: "compact", colorRules: [{ id: "c1", column: "status", op: "eq", value: "cancelled", tone: "bad" }, { id: "c2", column: "is_late", op: "eq", value: "true", tone: "warn" }], shared: true },
      { id: "v-late", name: "Late deliveries", table: ORD, layout: "grid", filters: [{ id: "f1", column: "is_late", op: "eq", value: "true" }], match: "all", sorts: [{ column: "delivery_minutes", dir: "desc" }], hidden: ["customer_id", "kitchen_id"], widths: {}, frozen: 1, density: "compact", colorRules: [], shared: true },
      { id: "v-board", name: "Customers by subscription", table: "analytics.dim_customers", layout: "board", filters: [], match: "all", sorts: [{ column: "lifetime_value", dir: "desc" }], hidden: [], widths: {}, frozen: 1, density: "regular", groupBy: "subscription_status", titleColumn: "full_name", colorRules: [], shared: true },
      { id: "v-pivot", name: "Revenue by kitchen and plan", table: PAY, layout: "pivot", filters: paid, match: "all", sorts: [], hidden: [], widths: {}, frozen: 0, density: "compact", pivotRow: "kitchen", pivotCol: "plan", pivotValue: "amount", pivotAgg: "sum", colorRules: [], shared: true },
    ],
    dashboards: [
      { id: "d-exec", name: "Executive overview", description: "Revenue, subscribers and retention.", owner: "Data team", filters: [], widgets: [
        w("s1", "City", "slicer", 0, 0, 4, 2, PAY, [], { dimension: "city" }),
        w("s2", "Plan", "slicer", 4, 0, 4, 2, PAY, [], { dimension: "plan" }),
        w("k1", "Revenue collected", "kpi", 0, 2, 3, 3, PAY, [{ column: "amount", agg: "sum" }], { filters: paid, format: "compact", trendDate: "paid_at" }),
        w("k2", "Active subscribers", "kpi", 3, 2, 3, 3, SUB, [{ column: "subscription_id", agg: "count_distinct" }], { filters: active }),
        w("k3", "Average delivery time, minutes", "kpi", 6, 2, 3, 3, ORD, [{ column: "delivery_minutes", agg: "avg" }]),
        w("k4", "Failed payments", "kpi", 9, 2, 3, 3, PAY, [{ column: "payment_id", agg: "count" }], { filters: [{ id: "x", column: "status", op: "eq", value: "failed" }] }),
        w("c1", "Revenue by month", "area", 0, 5, 8, 7, PAY, [{ column: "amount", agg: "sum", label: "Revenue" }], { dimension: "paid_at", dateGrain: "month", filters: paid, format: "compact" }),
        w("c2", "Revenue by kitchen", "bar", 8, 5, 4, 7, PAY, [{ column: "amount", agg: "sum", label: "Revenue" }], { dimension: "kitchen", filters: paid, format: "compact" }),
        w("c3", "Revenue by plan and quarter", "stacked_column", 0, 12, 6, 7, PAY, [{ column: "amount", agg: "sum" }], { dimension: "paid_at", dateGrain: "quarter", series: "plan", filters: paid, format: "compact" }),
        w("c4", "Why subscribers cancel", "donut", 6, 12, 3, 7, SUB, [{ column: "subscription_id", agg: "count", label: "Cancellations" }], { dimension: "cancel_reason", filters: cancelled }),
        w("c5", "Payment method", "treemap", 9, 12, 3, 7, PAY, [{ column: "amount", agg: "sum" }], { dimension: "method", filters: paid, format: "compact" }),
      ] },
      { id: "d-ops", name: "Kitchen operations", description: "Delivery quality across kitchens.", owner: "Data team", filters: [], widgets: [
        w("o1", "Orders", "kpi", 0, 0, 3, 3, ORD, [{ column: "order_id", agg: "count" }], { trendDate: "ordered_at" }),
        w("o2", "Late deliveries share", "gauge", 3, 0, 3, 5, MK, [{ column: "late_pct", agg: "avg" }], { target: 100, format: "percent" }),
        w("o3", "Average rating", "kpi", 0, 3, 3, 2, ORD, [{ column: "rating", agg: "avg" }]),
        w("o4", "Orders by month", "line", 6, 0, 6, 5, ORD, [{ column: "order_id", agg: "count", label: "Orders" }], { dimension: "ordered_at", dateGrain: "month" }),
        w("o5", "Kitchen scorecard", "table", 0, 5, 7, 6, MK, []),
        w("o6", "Orders by status", "bar", 7, 5, 5, 6, ORD, [{ column: "order_id", agg: "count" }], { dimension: "status" }),
        w("o7", "Orders by kitchen and meal", "heatmap", 0, 11, 12, 6, ORD, [{ column: "order_id", agg: "count" }], { dimension: "kitchen", series: "meal" }),
      ] },
    ],
    metrics: [
      { id: "m-rev", name: "Revenue collected", description: "Sum of paid payment amounts.", table: PAY, measure: { column: "amount", agg: "sum" }, dateColumn: "paid_at", format: "compact", owner: "Finance" },
      { id: "m-subs", name: "Subscriptions", description: "Unique subscriptions ever started.", table: SUB, measure: { column: "subscription_id", agg: "count_distinct" }, dateColumn: "started_at", format: "number", owner: "Growth" },
      { id: "m-orders", name: "Orders", description: "Meal orders placed.", table: ORD, measure: { column: "order_id", agg: "count" }, dateColumn: "ordered_at", format: "number", owner: "Operations" },
      { id: "m-del", name: "Average delivery time", description: "Average minutes from dispatch to delivery.", table: ORD, measure: { column: "delivery_minutes", agg: "avg" }, dateColumn: "ordered_at", format: "number", owner: "Operations" },
    ],
    queries: [{ id: "q-top", name: "Top customers by lifetime value", owner: "Data team", updatedAt: now, sql: "SELECT customer_id, full_name, kitchen, plan, lifetime_value\nFROM analytics.dim_customers\nORDER BY lifetime_value DESC\nLIMIT 50;" }],
  };
}
