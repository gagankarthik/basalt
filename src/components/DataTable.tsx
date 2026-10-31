"use client";

import { Btn, NoResults, Sel } from "./ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { Icon as BaseIcon, type IconName } from "./icons";

const cn = clsx;
const ICONS: Record<string, IconName> = { search: "search", "chevron-down": "chevDown", layers: "board", settings: "settings", upload: "upload", file: "file", x: "x", "chevron-right": "chevRight" };
const Icon = ({ name, className }: { name: string; className?: string }) => name === "chevron-left" ? <BaseIcon name="chevRight" className={className} style={{ transform: "rotate(180deg)" }} /> : <BaseIcon name={ICONS[name]} className={className} />;

export type ColumnDef<T> = {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number | null | undefined;
  searchValue?: (row: T) => string;
  exportValue?: (row: T) => string | number | null | undefined;
  align?: "start" | "end";
  width?: number;
  minWidth?: number;
  hideable?: boolean;
  defaultHidden?: boolean;
  // Pinned to the left edge on horizontal scroll. Use on the first column only.
  sticky?: boolean;
  // Let the content wrap instead of truncating.
  wrap?: boolean;
};

export type FilterDef<T> = {
  id: string;
  label: string;
  value: (row: T) => string | string[] | null | undefined;
  options?: { value: string; label?: string }[];
};

type Sort = { id: string; dir: "asc" | "desc" } | null;
type Density = "comfortable" | "compact";

type Prefs = {
  hidden?: string[];
  widths?: Record<string, number>;
  density?: Density;
  pageSize?: number;
  sort?: Sort;
};

const PAGE_SIZES = [10, 25, 50, 100];
const MIN_WIDTH = 72;
const MAX_WIDTH = 640;
const PREFIX = "basalt-table:";

const prefListeners = new Set<() => void>();
const prefCache = new Map<string, Prefs>();
const EMPTY: Prefs = {};

function readPrefs(id: string): Prefs {
  if (prefCache.has(id)) return prefCache.get(id)!;
  let value: Prefs = EMPTY;
  try {
    const raw = window.localStorage.getItem(PREFIX + id);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      value = parsed as Prefs;
  } catch {}
  prefCache.set(id, value);
  return value;
}

function writePrefs(id: string, patch: Partial<Prefs>) {
  const next = { ...readPrefs(id), ...patch };
  prefCache.set(id, next);
  try {
    window.localStorage.setItem(PREFIX + id, JSON.stringify(next));
  } catch {}
  prefListeners.forEach((listener) => listener());
}

function usePrefs(id: string) {
  const prefs = useSyncExternalStore(
    (listener) => {
      prefListeners.add(listener);
      return () => prefListeners.delete(listener);
    },
    () => readPrefs(id),
    () => EMPTY,
  );
  const update = useCallback(
    (patch: Partial<Prefs>) => writePrefs(id, patch),
    [id],
  );
  return [prefs, update] as const;
}

function compare(a: unknown, b: unknown) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function toCsv(rows: (string | number | null | undefined)[][]) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text = value == null ? "" : String(value);
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(","),
    )
    .join("\n");
}

function download(name: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Menu({
  label,
  trigger,
  children,
  align = "start",
  active,
}: {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "border-border bg-background hover:bg-surface-2 text-soft hover:text-foreground flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium transition-colors",
          active && "border-primary/40 bg-primary/5 text-primary",
        )}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "bg-background shadow-overlay absolute top-full z-50 mt-1.5 max-h-90 min-w-56 overflow-auto rounded-lg p-1.5",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function MenuCheck({
  checked,
  label,
  count,
  onChange,
}: {
  checked: boolean;
  label: string;
  count?: number;
  onChange: () => void;
}) {
  return (
    <label className="hover:bg-surface-2 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px]">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="accent-primary size-3.5"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="text-subtle tabular-nums">{count}</span>
      )}
    </label>
  );
}

type ExportRows = (string | number | null)[][];

function ExportMenu({
  label,
  trigger,
  onExport,
  xlsx,
}: {
  label: string;
  trigger: ReactNode;
  onExport: (format: "xlsx" | "csv") => void;
  xlsx: boolean;
}) {
  const item =
    "hover:bg-surface-2 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px]";
  return (
    <Menu label={label} align="end" trigger={trigger}>
      {xlsx && (
        <button
          type="button"
          role="menuitem"
          onClick={() => onExport("xlsx")}
          className={item}
        >
          <Icon name="file" className="text-subtle size-4" />
          Export as Excel (.xlsx)
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => onExport("csv")}
        className={item}
      >
        <Icon name="file" className="text-subtle size-4" />
        Export as CSV
      </button>
    </Menu>
  );
}

type SavedView = {
  name: string;
  query: string;
  active: Record<string, string[]>;
  sort: Sort;
  hidden: string[];
};

function readViews(key: string): SavedView[] {
  try {
    const raw = window.localStorage.getItem(`basalt-views-${key}`);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as SavedView[]) : [];
  } catch {
    return [];
  }
}

// Mounted only while the Views menu is open, so localStorage is never read during SSR.
function SavedViews({
  storageKey,
  current,
  onApply,
}: {
  storageKey: string;
  current: () => Omit<SavedView, "name">;
  onApply: (view: SavedView) => void;
}) {
  const [views, setViews] = useState(() => readViews(storageKey));
  const [name, setName] = useState("");
  const store = (next: SavedView[]) => {
    setViews(next);
    try {
      window.localStorage.setItem(
        `basalt-views-${storageKey}`,
        JSON.stringify(next),
      );
    } catch {}
  };
  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    store([
      ...views.filter((v) => v.name !== trimmed),
      { name: trimmed, ...current() },
    ]);
    setName("");
  };

  return (
    <>
      <p className="text-subtle px-2 pt-1 pb-1.5 text-[11.5px]! font-medium">
        Saved views
      </p>
      {views.length === 0 && (
        <p className="text-subtle px-2 py-1.5 text-[13px]">
          No saved views yet
        </p>
      )}
      {views.map((view) => (
        <div
          key={view.name}
          className="hover:bg-surface-2 flex items-center gap-1 rounded-md"
        >
          <button
            type="button"
            onClick={() => onApply(view)}
            className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-[13px]"
          >
            {view.name}
          </button>
          <button
            type="button"
            aria-label={`Delete view ${view.name}`}
            onClick={() => store(views.filter((v) => v.name !== view.name))}
            className="text-subtle hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-md"
          >
            <Icon name="x" className="size-3.5" />
          </button>
        </div>
      ))}
      <div className="bg-border my-1.5 h-px" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex items-center gap-1.5 px-1 pb-0.5"
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name this view"
          aria-label="View name"
          className="border-input focus:border-foreground/60 focus:ring-ring/40 h-9 min-w-0 flex-1 rounded-md border px-2 text-[13px] outline-none focus:ring-2"
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="border-border hover:bg-surface-2 h-9 rounded-md border px-2.5 text-[13px] font-medium disabled:opacity-50"
        >
          Save
        </button>
      </form>
    </>
  );
}

export default function DataTable<T>({
  id,
  rows,
  rowKey,
  columns,
  filters = [],
  searchPlaceholder = "Search",
  onRowClick,
  bulkActions,
  toolbar,
  empty,
  exportName,
  exportable = false,
  exportXlsx,
  initialSort = null,
  defaultPageSize = 25,
  selectable = true,
  bleed = false,
  activeRowKey,
  initialFilters,
  viewsKey,
}: {
  id: string;
  rows: T[];
  rowKey: (row: T) => string;
  columns: ColumnDef<T>[];
  filters?: FilterDef<T>[];
  searchPlaceholder?: string;
  onRowClick?: (row: T) => void;
  bulkActions?: (selected: T[], clear: () => void) => ReactNode;
  toolbar?: ReactNode;
  empty?: ReactNode;
  exportName?: string;
  // CSV export is a staff-only tool; customer-facing apps leave it off.
  exportable?: boolean;
  // Adds "Export as Excel" to the export menu. Apps pass their own writer so shared code stays dependency-free.
  exportXlsx?: (rows: ExportRows, filename: string) => void | Promise<void>;
  initialSort?: Sort;
  defaultPageSize?: number;
  selectable?: boolean;
  bleed?: boolean;
  activeRowKey?: string | null;
  initialFilters?: Record<string, string[]>;
  // Enables a "Views" menu to save and restore search, filters, sort and hidden columns.
  viewsKey?: string;
}) {
  const [prefs, setPrefs] = usePrefs(id);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<Record<string, string[]>>(
    initialFilters ?? {},
  );
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resizing, setResizing] = useState<string | null>(null);
  const [tools, setTools] = useState(false);

  const hidden = useMemo(
    () =>
      new Set(
        prefs.hidden ?? columns.filter((c) => c.defaultHidden).map((c) => c.id),
      ),
    [prefs.hidden, columns],
  );
  const density = prefs.density ?? "comfortable";
  const pageSize = prefs.pageSize ?? defaultPageSize;
  const sort = prefs.sort === undefined ? initialSort : prefs.sort;
  const visible = columns.filter((c) => !hidden.has(c.id));

  const filterOptions = useMemo(
    () =>
      filters.map((filter) => {
        const counts = new Map<string, number>();
        for (const row of rows) {
          const raw = filter.value(row);
          const values = Array.isArray(raw)
            ? raw
            : raw == null || raw === ""
              ? []
              : [raw];
          for (const value of values)
            counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        const options =
          filter.options ??
          [...counts.keys()]
            .sort((a, b) => a.localeCompare(b))
            .map((value) => ({ value, label: value }));
        return {
          filter,
          options: options.map((o) => ({
            value: o.value,
            label: o.label ?? o.value,
            count: counts.get(o.value) ?? 0,
          })),
        };
      }),
    [filters, rows],
  );

  const processed = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = rows.filter((row) => {
      for (const filter of filters) {
        const chosen = active[filter.id];
        if (!chosen?.length) continue;
        const raw = filter.value(row);
        const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
        if (!values.some((v) => chosen.includes(v))) return false;
      }
      if (!q) return true;
      return columns.some((column) => {
        const text =
          column.searchValue?.(row) ??
          (column.sortValue ? String(column.sortValue(row) ?? "") : "");
        return text.toLowerCase().includes(q);
      });
    });
    if (sort) {
      const column = columns.find((c) => c.id === sort.id);
      if (column?.sortValue) {
        const get = column.sortValue;
        list = [...list].sort(
          (a, b) => compare(get(a), get(b)) * (sort.dir === "asc" ? 1 : -1),
        );
      }
    }
    return list;
  }, [rows, filters, active, query, sort, columns]);

  const pages = Math.max(1, Math.ceil(processed.length / pageSize));
  const current = Math.min(page, pages - 1);
  const pageRows = processed.slice(
    current * pageSize,
    current * pageSize + pageSize,
  );
  const selectedRows = processed.filter((row) => selected.has(rowKey(row)));
  const pageKeys = pageRows.map(rowKey);
  const allOnPage =
    pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
  const someOnPage = pageKeys.some((k) => selected.has(k));
  const activeCount = Object.values(active).reduce((n, v) => n + v.length, 0);

  const toggleSort = (column: ColumnDef<T>) => {
    if (!column.sortValue) return;
    const next: Sort =
      sort?.id !== column.id
        ? { id: column.id, dir: "asc" }
        : sort.dir === "asc"
          ? { id: column.id, dir: "desc" }
          : null;
    setPrefs({ sort: next });
  };

  const toggleFilter = (filterId: string, value: string) => {
    setPage(0);
    setActive((prev) => {
      const list = prev[filterId] ?? [];
      return {
        ...prev,
        [filterId]: list.includes(value)
          ? list.filter((v) => v !== value)
          : [...list, value],
      };
    });
  };

  const clearAll = () => {
    setActive({});
    setQuery("");
    setPage(0);
  };

  const exportRows = (source: T[], format: "xlsx" | "csv" = "csv") => {
    const cols = visible.filter(
      (c) => c.exportValue || c.sortValue || c.searchValue,
    );
    const data: ExportRows = [
      cols.map((c) => c.header),
      ...source.map((row) =>
        cols.map(
          (c) => (c.exportValue ?? c.sortValue ?? c.searchValue)!(row) ?? "",
        ),
      ),
    ];
    const base = `${exportName ?? id}-${new Date().toISOString().slice(0, 10)}`;
    if (format === "xlsx" && exportXlsx) void exportXlsx(data, `${base}.xlsx`);
    else download(`${base}.csv`, toCsv(data));
  };

  const startResize = (
    column: ColumnDef<T>,
    event: ReactPointerEvent<HTMLSpanElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const th = (event.currentTarget.parentElement as HTMLElement) ?? null;
    const startX = event.clientX;
    const startWidth = th?.getBoundingClientRect().width ?? column.width ?? 160;
    setResizing(column.id);
    const onMove = (e: PointerEvent) => {
      const width = Math.round(
        Math.min(
          MAX_WIDTH,
          Math.max(
            column.minWidth ?? MIN_WIDTH,
            startWidth + e.clientX - startX,
          ),
        ),
      );
      setPrefs({
        widths: { ...(readPrefs(id).widths ?? {}), [column.id]: width },
      });
    };
    const onUp = () => {
      setResizing(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const widthOf = (column: ColumnDef<T>) =>
    prefs.widths?.[column.id] ?? column.width;
  const cellPad = density === "compact" ? "py-1" : "py-2";
  const pinned = visible[0]?.sticky === true;
  const stickyLeft = selectable ? 44 : 0;
  // Opaque so scrolled cells pass underneath; mirrors the row hover colour.
  const stickyCell =
    "bg-background group-hover/row:bg-surface-2 group-focus-visible/row:bg-surface-2 sticky z-[1]";

  const onRowKey = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (event.key === "Enter" && onRowClick) onRowClick(row);
  };

  // Nothing to search or page through yet, so the empty state stands alone
  if (!rows.length && empty) return <>{empty}</>;

  return (
    <div
      className={cn(
        "bg-background flex min-w-0 flex-col overflow-hidden",
        bleed ? "min-h-0 flex-1" : "border-border border-t",
      )}
    >
      <div
        className={cn(
          "border-border flex flex-wrap items-center gap-2 border-b phone-fold",
          tools && "open",
          bleed ? "px-5 py-2.5 lg:px-6" : "px-3 py-2",
        )}
      >
        <label className="keep relative flex min-w-40 flex-1 items-center sm:max-w-72">
          <span className="sr-only">{searchPlaceholder}</span>
          <Icon
            name="search"
            className="text-subtle pointer-events-none absolute left-2.5 size-4"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder={searchPlaceholder}
            className="border-input focus:border-foreground/60 focus:ring-ring/40 h-9 w-full rounded-md border pr-2.5 pl-8 text-[13px] outline-none focus:ring-2"
          />
        </label>

        <Btn className="keep fold-btn" icon="filter" aria-expanded={tools} onClick={() => setTools(!tools)}>Options</Btn>

        {filterOptions.map(({ filter, options }) => {
          const chosen = active[filter.id] ?? [];
          return (
            <Menu
              key={filter.id}
              label={`Filter by ${filter.label}`}
              active={chosen.length > 0}
              trigger={
                <>
                  <span className="text-subtle font-normal">
                    {filter.label}
                  </span>
                  <span className="text-foreground max-w-40 truncate font-medium">
                    {chosen.length === 0
                      ? "Any"
                      : (options.find((o) => o.value === chosen[0])?.label ??
                        chosen[0])}
                    {chosen.length > 1 && (
                      <span className="text-soft font-normal">
                        {" "}
                        +{chosen.length - 1}
                      </span>
                    )}
                  </span>
                  <Icon name="chevron-down" className="text-subtle size-3.5" />
                </>
              }
            >
              <p className="text-subtle px-2 pt-1 pb-1.5 text-[11.5px]! font-medium">
                {filter.label}
              </p>
              {options.map((option) => (
                <MenuCheck
                  key={option.value}
                  label={option.label}
                  count={option.count}
                  checked={chosen.includes(option.value)}
                  onChange={() => toggleFilter(filter.id, option.value)}
                />
              ))}
              {chosen.length > 0 && (
                <button
                  type="button"
                  onClick={() => setActive((p) => ({ ...p, [filter.id]: [] }))}
                  className="text-soft hover:text-foreground mt-1 w-full rounded-md px-2 py-1.5 text-left text-[12.5px]"
                >
                  Clear {filter.label.toLowerCase()}
                </button>
              )}
            </Menu>
          );
        })}

        {(activeCount > 0 || query) && (
          <button
            type="button"
            onClick={clearAll}
            className="text-soft hover:text-foreground min-h-6 px-1 text-[13px] font-medium"
          >
            Clear all
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {toolbar}
          {viewsKey && (
            <Menu
              label="Saved views"
              align="end"
              trigger={
                <>
                  <Icon name="layers" className="size-4" />
                  <span className="hidden sm:inline">Views</span>
                </>
              }
            >
              <SavedViews
                storageKey={viewsKey}
                current={() => ({ query, active, sort, hidden: [...hidden] })}
                onApply={(view) => {
                  setQuery(view.query ?? "");
                  setActive(view.active ?? {});
                  setPage(0);
                  setPrefs({ sort: view.sort ?? null, hidden: view.hidden });
                }}
              />
            </Menu>
          )}
          <Menu
            label="Table settings"
            align="end"
            trigger={
              <>
                <Icon name="settings" className="size-4" />
                <span className="hidden sm:inline">View</span>
              </>
            }
          >
            <p className="text-subtle px-2 pt-1 pb-1.5 text-[11.5px]! font-medium">
              Columns
            </p>
            {columns.map((column) => (
              <MenuCheck
                key={column.id}
                label={column.header}
                checked={!hidden.has(column.id)}
                onChange={() => {
                  if (column.hideable === false) return;
                  const next = new Set(hidden);
                  if (next.has(column.id)) next.delete(column.id);
                  else next.add(column.id);
                  setPrefs({ hidden: [...next] });
                }}
              />
            ))}
            <div className="bg-border my-1.5 h-px" />
            <p className="text-subtle px-2 pt-1 pb-1.5 text-[11.5px]! font-medium">
              Density
            </p>
            {(["comfortable", "compact"] as Density[]).map((value) => (
              <label
                key={value}
                className="hover:bg-surface-2 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] capitalize"
              >
                <input
                  type="radio"
                  name={`${id}-density`}
                  checked={density === value}
                  onChange={() => setPrefs({ density: value })}
                  className="accent-primary size-3.5"
                />
                {value}
              </label>
            ))}
            <div className="bg-border my-1.5 h-px" />
            <button
              type="button"
              onClick={() =>
                setPrefs({
                  hidden: undefined,
                  widths: undefined,
                  sort: undefined,
                  density: undefined,
                })
              }
              className="text-soft hover:text-foreground hover:bg-surface-2 w-full rounded-md px-2 py-1.5 text-left text-[13px]"
            >
              Reset view
            </button>
          </Menu>
          {exportable && (
            <ExportMenu
              label={`Export ${processed.length} rows`}
              xlsx={!!exportXlsx}
              onExport={(format) => exportRows(processed, format)}
              trigger={
                <>
                  <Icon name="upload" className="size-4 rotate-180" />
                  <span className="hidden sm:inline">Export</span>
                  <Icon name="chevron-down" className="text-subtle size-3.5" />
                </>
              }
            />
          )}
        </div>
      </div>

      {selectable && selectedRows.length > 0 && (
        <div
          className={cn(
            "bg-primary/5 border-primary/20 flex flex-wrap items-center gap-2 border-b py-2 text-[13px]",
            bleed ? "px-5 lg:px-6" : "px-4",
          )}
        >
          <span className="text-primary font-semibold tabular-nums">
            {selectedRows.length} selected
          </span>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-soft hover:text-foreground"
          >
            Clear
          </button>
          {exportable && (
            <>
              <span className="bg-border mx-1 h-4 w-px" />
              <ExportMenu
                label={`Export ${selectedRows.length} selected rows`}
                xlsx={!!exportXlsx}
                onExport={(format) => exportRows(selectedRows, format)}
                trigger={
                  <>
                    Export selected
                    <Icon name="chevron-down" className="size-3.5" />
                  </>
                }
              />
            </>
          )}
          {bulkActions?.(selectedRows, () => setSelected(new Set()))}
        </div>
      )}

      {processed.length === 0 ? (
        <NoResults what={searchPlaceholder.replace(/^Search /, "") === "Search" ? "results" : searchPlaceholder.replace(/^Search /, "")} onClear={activeCount > 0 || query ? clearAll : undefined} />
      ) : (
        <div
          className={cn(
            "overflow-auto",
            bleed && "min-h-0 flex-1",
            resizing && "cursor-col-resize select-none",
          )}
        >
          <table className="w-full min-w-max table-fixed border-separate border-spacing-0 text-[13.5px]">
            <colgroup>
              {selectable && <col style={{ width: 44 }} />}
              {visible.map((column) => (
                <col key={column.id} style={{ width: widthOf(column) }} />
              ))}
            </colgroup>
            <thead className="bg-surface-2 sticky top-0 z-30">
              <tr>
                {selectable && (
                  <th
                    className={cn(
                      "border-border border-b",
                      pinned && "bg-surface-2 sticky left-0 z-20",
                    )}
                  >
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={allOnPage}
                      ref={(node) => {
                        if (node) node.indeterminate = !allOnPage && someOnPage;
                      }}
                      onChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (allOnPage)
                            pageKeys.forEach((k) => next.delete(k));
                          else pageKeys.forEach((k) => next.add(k));
                          return next;
                        })
                      }
                      className="accent-primary size-3.5"
                    />
                  </th>
                )}
                {visible.map((column) => {
                  const sorted = sort?.id === column.id ? sort.dir : null;
                  return (
                    <th
                      key={column.id}
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                      className={cn(
                        "border-border text-soft group/th relative h-10 border-b px-3 text-left text-[12px] font-medium whitespace-nowrap",
                        column.align === "end" && "text-right",
                        column.sticky &&
                          "bg-surface-2 sticky z-20 shadow-[inset_-1px_0_0_var(--color-border)]",
                      )}
                      style={column.sticky ? { left: stickyLeft } : undefined}
                    >
                      {column.sortValue ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(column)}
                          className={cn(
                            "hover:text-foreground inline-flex min-h-6 items-center gap-1 transition-colors",
                            sorted && "text-foreground",
                            column.align === "end" && "flex-row-reverse",
                          )}
                        >
                          {column.header}
                          <Icon
                            name="chevron-down"
                            className={cn(
                              "size-3.5 transition-transform",
                              sorted
                                ? "opacity-100"
                                : "opacity-0 group-hover/th:opacity-40",
                              sorted === "asc" && "rotate-180",
                            )}
                          />
                        </button>
                      ) : (
                        column.header
                      )}
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${column.header}`}
                        onPointerDown={(e) => startResize(column, e)}
                        onDoubleClick={() => {
                          const widths = { ...(prefs.widths ?? {}) };
                          delete widths[column.id];
                          setPrefs({ widths });
                        }}
                        className={cn(
                          "hover:after:bg-line-strong absolute top-1.5 right-0 bottom-1.5 w-2 cursor-col-resize after:absolute after:inset-y-0 after:right-0.5 after:w-px after:bg-transparent",
                          resizing === column.id && "after:bg-primary",
                        )}
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => {
                const key = rowKey(row);
                const isSelected = selected.has(key);
                return (
                  <tr
                    key={key}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={(e) => onRowKey(e, row)}
                    className={cn(
                      "group/row transition-colors outline-none",
                      onRowClick && "focus-visible:bg-surface-2 cursor-pointer",
                      isSelected || (activeRowKey && activeRowKey === key)
                        ? "bg-primary/[0.04]"
                        : "hover:bg-surface-2",
                    )}
                  >
                    {selectable && (
                      <td
                        className={cn(
                          "border-border border-b",
                          cellPad,
                          pinned && stickyCell + " left-0",
                        )}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          aria-label="Select row"
                          checked={isSelected}
                          onChange={() =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                          className="accent-primary size-3.5"
                        />
                      </td>
                    )}
                    {visible.map((column) => (
                      <td
                        key={column.id}
                        className={cn(
                          "border-border border-b px-3 align-middle",
                          column.wrap ? "break-words" : "truncate",
                          cellPad,
                          column.align === "end" && "text-right tabular-nums",
                          column.sticky &&
                            stickyCell +
                              " shadow-[inset_-1px_0_0_var(--color-border)]",
                        )}
                        style={column.sticky ? { left: stickyLeft } : undefined}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div
        className={cn(
          "text-soft flex flex-wrap items-center justify-between gap-3 py-2.5 text-[12.5px]",
          bleed ? "border-border border-t px-5 lg:px-6" : "px-3",
        )}
      >
        <span className="tabular-nums">
          {processed.length === 0
            ? "0 results"
            : `${current * pageSize + 1}–${Math.min(processed.length, (current + 1) * pageSize)} of ${processed.length}`}
          {processed.length !== rows.length &&
            ` (filtered from ${rows.length})`}
        </span>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            Rows
            <Sel aria-label="Rows per page" value={String(pageSize)} onChange={(v) => { setPrefs({ pageSize: Number(v) }); setPage(0); }} options={PAGE_SIZES.map(String)} />
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous page"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
              className="hover:bg-layer-1 flex size-9 items-center justify-center rounded-md disabled:opacity-40"
            >
              <Icon name="chevron-left" className="size-4" />
            </button>
            <span className="tabular-nums">
              {current + 1} / {pages}
            </span>
            <button
              type="button"
              aria-label="Next page"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
              className="hover:bg-layer-1 flex size-9 items-center justify-center rounded-md disabled:opacity-40"
            >
              <Icon name="chevron-right" className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
