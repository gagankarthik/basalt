import { q, table } from "./sql.ts";
import type { NotebookCell } from "./notebook.ts";

export type TemplateField = { key: string; label: string; hint?: string; table?: boolean };
type Cell = [NotebookCell["kind"], string];
export type AnalysisTemplate = { id: string; name: string; note: string; fields: TemplateField[]; cells: (p: Record<string, string>) => Cell[] };

const USER: TemplateField = { key: "user", label: "Who", hint: "A customer or user ID" };
const DATE: TemplateField = { key: "date", label: "When", hint: "A date or timestamp" };
const VALUE: TemplateField = { key: "value", label: "Amount", hint: "A number to add up" };
const col = (p: Record<string, string>, k: string) => q(p[k]);
const day = (p: Record<string, string>) => `TRY_CAST(${col(p, "date")} AS DATE)`;
const from = (p: Record<string, string>, k = "table") => table(p[k]);

/** Standard analyses, each ready to run once its columns are chosen. Column and table names are always quoted, so a chosen name can't change the query. */
export const TEMPLATES: AnalysisTemplate[] = [
  { id: "profile", name: "Explore a table", note: "Column types, empty values, ranges and a sample of rows.", fields: [], cells: (p) => [
    ["text", `A first look at ${p.table}: each column's type, how much is empty, its range, and some example rows.`],
    ["sql", `SUMMARIZE SELECT * FROM ${from(p)}`],
    ["sql", `SELECT * FROM ${from(p)} LIMIT 100`],
  ] },
  { id: "quality", name: "Data quality audit", note: "Duplicates, missing keys, future dates and the emptiest columns.", fields: [{ key: "key", label: "Unique key", hint: "A column that should be unique" }, DATE], cells: (p) => [
    ["text", `Checks ${p.table} for problems. Each number in the first result should be 0.`],
    ["sql", `SELECT count(*) AS total_rows,\n  count(*) - count(DISTINCT ${col(p, "key")}) - count(*) FILTER (WHERE ${col(p, "key")} IS NULL) AS duplicate_keys,\n  count(*) FILTER (WHERE ${col(p, "key")} IS NULL) AS missing_keys,\n  count(*) FILTER (WHERE ${day(p)} > current_date) AS future_dates,\n  count(*) FILTER (WHERE ${col(p, "date")} IS NOT NULL AND ${day(p)} IS NULL) AS unreadable_dates\nFROM ${from(p)}`],
    ["sql", `SELECT column_name, column_type, null_percentage, approx_unique\nFROM (SUMMARIZE SELECT * FROM ${from(p)})\nORDER BY CAST(replace(CAST(null_percentage AS VARCHAR), '%', '') AS DOUBLE) DESC`],
  ] },
  { id: "cohort", name: "Cohort retention", note: "Of the people who started in a month, how many came back later.", fields: [USER, DATE], cells: (p) => [
    ["text", "Each row is a group of people who first appeared in the same month. Month 0 is always 100%, and later months show how many returned."],
    ["sql", `WITH activity AS (\n  SELECT DISTINCT ${col(p, "user")} AS who, date_trunc('month', ${day(p)}) AS month\n  FROM ${from(p)} WHERE ${col(p, "user")} IS NOT NULL AND ${day(p)} IS NOT NULL\n), firsts AS (\n  SELECT who, min(month) AS cohort FROM activity GROUP BY 1\n), sizes AS (\n  SELECT cohort, count(*) AS size FROM firsts GROUP BY 1\n)\nSELECT strftime(f.cohort, '%Y-%m') AS cohort, date_diff('month', f.cohort, a.month) AS months_since_start, count(*) AS people, s.size AS cohort_size, round(100.0 * count(*) / s.size, 1) AS retention_pct\nFROM activity a JOIN firsts f USING (who) JOIN sizes s USING (cohort)\nGROUP BY f.cohort, a.month, s.size ORDER BY f.cohort, months_since_start`],
  ] },
  { id: "funnel", name: "Conversion funnel", note: "How many people reach each step, and where they drop off.", fields: [USER, { key: "step", label: "Step", hint: "The stage or event name" }], cells: (p) => [
    ["text", "Steps are ordered from most people to fewest. The biggest drop shows where to look first."],
    ["sql", `WITH steps AS (\n  SELECT CAST(${col(p, "step")} AS VARCHAR) AS step, count(DISTINCT ${col(p, "user")}) AS people\n  FROM ${from(p)} WHERE ${col(p, "step")} IS NOT NULL GROUP BY 1\n)\nSELECT step, people,\n  round(100.0 * people / max(people) OVER (), 1) AS pct_of_first_step,\n  round(100.0 * people / lag(people) OVER (ORDER BY people DESC, step), 1) AS pct_of_previous_step\nFROM steps ORDER BY people DESC, step`],
  ] },
  { id: "segments", name: "Customer segments (RFM)", note: "Groups customers by how recently, how often and how much they buy.", fields: [USER, DATE, VALUE], cells: (p) => [
    ["text", "Each customer scores 1 to 4 for recency, frequency and spend, where 4 is best. The second result lists them with their segment."],
    ["sql", `WITH c AS (\n  SELECT ${col(p, "user")} AS customer, date_diff('day', max(${day(p)}), current_date) AS days_since_last, count(*) AS purchases, sum(${col(p, "value")}) AS spend\n  FROM ${from(p)} WHERE ${col(p, "user")} IS NOT NULL AND ${day(p)} IS NOT NULL GROUP BY 1\n), scored AS (\n  SELECT *, ntile(4) OVER (ORDER BY days_since_last DESC) AS r, ntile(4) OVER (ORDER BY purchases) AS f, ntile(4) OVER (ORDER BY spend) AS m FROM c\n)\nSELECT CASE WHEN r >= 3 AND f >= 3 AND m >= 3 THEN 'Best' WHEN r >= 3 THEN 'Recent' WHEN f >= 3 OR m >= 3 THEN 'Slipping' ELSE 'Lost' END AS segment,\n  count(*) AS customers, round(avg(days_since_last), 1) AS avg_days_since_last, round(avg(purchases), 1) AS avg_purchases, round(sum(spend), 2) AS total_spend\nFROM scored GROUP BY 1 ORDER BY total_spend DESC`],
  ] },
  { id: "trend", name: "Trend over time", note: "Monthly totals, change, a moving average and a straight-line forecast.", fields: [DATE, VALUE], cells: (p) => {
    const monthly = `SELECT date_trunc('month', ${day(p)}) AS month, sum(${col(p, "value")}) AS total FROM ${from(p)} WHERE ${day(p)} IS NOT NULL GROUP BY 1`;
    return [
      ["text", "The forecast continues the straight-line trend for three months. It doesn't account for seasons, so treat it as a rough guide."],
      ["sql", `SELECT strftime(month, '%Y-%m') AS month, total,\n  round(avg(total) OVER (ORDER BY month ROWS 2 PRECEDING), 2) AS moving_avg_3_months,\n  round(100.0 * (total - lag(total) OVER (ORDER BY month)) / nullif(lag(total) OVER (ORDER BY month), 0), 1) AS change_pct\nFROM (${monthly}) ORDER BY 1`],
      ["sql", `WITH m AS (SELECT row_number() OVER (ORDER BY month) AS n, month, total FROM (${monthly})), fit AS (SELECT regr_slope(total, n) AS slope, regr_intercept(total, n) AS intercept, max(n) AS last_n, max(month) AS last_month FROM m)\nSELECT strftime(last_month + to_months(CAST(k AS INTEGER)), '%Y-%m') AS month, round(intercept + slope * (last_n + k), 2) AS forecast\nFROM fit, range(1, 4) AS t(k) ORDER BY 1`],
    ];
  } },
  { id: "abtest", name: "A/B test", note: "Compares two variants' conversion rates and whether the gap is significant.", fields: [{ key: "variant", label: "Variant", hint: "Exactly two values, such as A and B" }, { key: "converted", label: "Converted", hint: "True or false, or 1 or 0" }], cells: (p) => {
    const rates = `SELECT CAST(${col(p, "variant")} AS VARCHAR) AS variant, count(*) AS n, avg(CAST(TRY_CAST(${col(p, "converted")} AS BOOLEAN) AS INTEGER)) AS rate FROM ${from(p)} WHERE ${col(p, "variant")} IS NOT NULL AND TRY_CAST(${col(p, "converted")} AS BOOLEAN) IS NOT NULL GROUP BY 1`;
    return [
      ["text", "A two-proportion z-test at 95% confidence. It only gives a verdict for exactly two variants, and a result is only sound if the test's size was decided before it started."],
      ["sql", `SELECT variant, n AS people, round(100.0 * rate, 2) AS conversion_pct FROM (${rates}) ORDER BY 1`],
      ["sql", `WITH r AS (${rates}), s AS (\n  SELECT count(*) AS variants, min(rate) FILTER (WHERE variant = (SELECT min(variant) FROM r)) AS p1, min(n) FILTER (WHERE variant = (SELECT min(variant) FROM r)) AS n1, min(rate) FILTER (WHERE variant = (SELECT max(variant) FROM r)) AS p2, min(n) FILTER (WHERE variant = (SELECT max(variant) FROM r)) AS n2 FROM r\n), z AS (\n  SELECT *, (p2 - p1) / nullif(sqrt(((p1 * n1 + p2 * n2) / (n1 + n2)) * (1 - (p1 * n1 + p2 * n2) / (n1 + n2)) * (1.0 / n1 + 1.0 / n2)), 0) AS z_score FROM s\n)\nSELECT variants, round(100.0 * (p2 - p1), 2) AS difference_points, round(z_score, 3) AS z_score,\n  CASE WHEN variants <> 2 THEN 'Needs exactly two variants' WHEN z_score IS NULL THEN 'No difference to test' WHEN abs(z_score) >= 1.96 THEN 'Significant' ELSE 'Not significant' END AS verdict\nFROM z`],
    ];
  } },
  { id: "rootcause", name: "What changed?", note: "Compares the latest month with the one before, broken down by a column.", fields: [DATE, VALUE, { key: "dim", label: "Break down by", hint: "A category such as region or product" }], cells: (p) => [
    ["text", "The rows at the top explain most of the change between the two latest months."],
    ["sql", `WITH last_months AS (SELECT DISTINCT date_trunc('month', ${day(p)}) AS month FROM ${from(p)} WHERE ${day(p)} IS NOT NULL ORDER BY 1 DESC LIMIT 2), b AS (\n  SELECT CAST(${col(p, "dim")} AS VARCHAR) AS segment,\n    coalesce(sum(${col(p, "value")}) FILTER (WHERE date_trunc('month', ${day(p)}) = (SELECT max(month) FROM last_months)), 0) AS latest,\n    coalesce(sum(${col(p, "value")}) FILTER (WHERE date_trunc('month', ${day(p)}) = (SELECT min(month) FROM last_months)), 0) AS previous\n  FROM ${from(p)} GROUP BY 1\n)\nSELECT segment, previous, latest, latest - previous AS change, round(100.0 * (latest - previous) / nullif(sum(abs(latest - previous)) OVER (), 0), 1) AS share_of_change_pct\nFROM b ORDER BY abs(latest - previous) DESC`],
  ] },
  { id: "reconcile", name: "Reconcile two tables", note: "Finds the months where the same number differs between two tables.", fields: [DATE, VALUE, { key: "table2", label: "Other table", table: true }, { key: "date2", label: "Other table's date" }, { key: "value2", label: "Other table's amount" }], cells: (p) => [
    ["text", `Compares ${p.table} with ${p.table2}. Any row here is a month where they disagree.`],
    ["sql", `WITH a AS (SELECT date_trunc('month', ${day(p)}) AS month, sum(${col(p, "value")}) AS total FROM ${from(p)} GROUP BY 1), b AS (SELECT date_trunc('month', TRY_CAST(${col(p, "date2")} AS DATE)) AS month, sum(${col(p, "value2")}) AS total FROM ${from(p, "table2")} GROUP BY 1)\nSELECT strftime(coalesce(a.month, b.month), '%Y-%m') AS month, a.total AS first_table, b.total AS other_table, round(coalesce(a.total, 0) - coalesce(b.total, 0), 2) AS difference\nFROM a FULL JOIN b ON a.month = b.month\nWHERE coalesce(a.month, b.month) IS NOT NULL AND abs(coalesce(a.total, 0) - coalesce(b.total, 0)) > 0.005 ORDER BY 1`],
  ] },
];

export const templateCells = (id: string, params: Record<string, string>, newId: () => string): NotebookCell[] | null => {
  const t = TEMPLATES.find((x) => x.id === id);
  return t ? t.cells(params).map(([kind, source]) => ({ id: newId(), kind, source })) : null;
};
