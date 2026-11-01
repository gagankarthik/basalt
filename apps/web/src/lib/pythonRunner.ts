/** What runs a Python model: the file a separate process loads, for model(dbt, session) as in dbt, or the older transform(tables). */
export const MODEL_RUNNER = `
import importlib.util, json, math, sys
inp, out, code = sys.argv[1:4]
with open(inp, encoding="utf8") as f:
    data = json.load(f)
refs, sources = data["refs"], data["sources"]
class Config:
    def __init__(self):
        self.values = {}
    def __call__(self, **kw):
        self.values.update(kw)
    def get(self, key, default=None):
        return self.values.get(key, default)
class Dbt:
    config = Config()
    this = None
    is_incremental = False
    def ref(self, name, *a, **k):
        if name not in refs:
            raise KeyError(f"Add {name} as an input: it isn't built before this model.")
        return refs[name]
    def source(self, conn, table):
        key = f"raw_{conn}.{table}"
        if key not in sources:
            raise KeyError(f"There's no synced table {conn}.{table}.")
        return sources[key]
spec = importlib.util.spec_from_file_location("user_model", code)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
if hasattr(mod, "model"):
    rows = mod.model(Dbt(), None)
else:
    rows = mod.transform({**refs, **{k.split(".")[1]: v for k, v in sources.items()}})
if hasattr(rows, "to_dict"):
    rows = rows.to_dict("records")
def clean(v):
    return None if isinstance(v, float) and (math.isnan(v) or math.isinf(v)) else v
rows = [{k: clean(v) for k, v in r.items()} for r in rows]
with open(out, "w", encoding="utf8") as f:
    json.dump(rows, f, default=str, allow_nan=False)
`;

/**
 * Runs one notebook cell in its own process. Variables come back from state.pkl, and functions, classes and imports are restored by running their source again.
 * Nothing lingers between cells, so a stuck cell can't hold memory on the server the warehouse shares. A value that can't be saved, such as an open file, is named in the output.
 */
export const CELL_RUNNER = `
def _basalt_run():
    import __main__, ast, json, math, os, pickle, sys, traceback, types
    inp, out, code = sys.argv[1:4]
    STATE, LIMIT = "state.pkl", 256 * 1024 * 1024
    with open(inp, encoding="utf8") as f:
        results = json.load(f)
    shown = []
    def display(rows):
        if hasattr(rows, "to_dict"):
            rows = rows.to_dict("records")
        shown.append(list(rows))
    g = __main__.__dict__
    g["results"], g["display"] = results, display
    state = {"defs": [], "vars": {}}
    if os.path.exists(STATE):
        with open(STATE, "rb") as f:
            state = pickle.load(f)
    for d in state["defs"]:
        try:
            exec(compile(d, "cell", "exec"), g)
        except Exception as e:
            print(f"An earlier definition couldn't be restored: {e}")
    for k, b in state["vars"].items():
        try:
            g[k] = pickle.loads(b)
        except Exception as e:
            print(f"{k} couldn't be restored: {e}")
    with open(code, encoding="utf8") as f:
        source = f.read()
    failed, tree = False, None
    try:
        tree = ast.parse(source, "cell")
        exec(compile(tree, "cell", "exec"), g)
    except Exception as e:
        failed = True
        tb = e.__traceback__.tb_next if e.__traceback__ else None
        traceback.print_exception(type(e), e, tb)
    # What a cell made before failing is kept, as it would be in any notebook
    lines = source.splitlines()
    for n in (tree.body if tree else []):
        if isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            start = min([n.lineno] + [x.lineno for x in getattr(n, "decorator_list", [])])
            d = "\\n".join(lines[start - 1:n.end_lineno])
            if d in state["defs"]:
                state["defs"].remove(d)
            state["defs"].append(d)
    keep, lost, size = {}, [], 0
    for k, v in list(g.items()):
        if k.startswith("__") or k in ("results", "display", "_basalt_run") or isinstance(v, (types.ModuleType, types.FunctionType, type)):
            continue
        try:
            b = pickle.dumps(v)
        except Exception:
            lost.append(k)
            continue
        if size + len(b) > LIMIT:
            lost.append(k)
            continue
        size += len(b)
        keep[k] = b
    state["vars"] = keep
    if lost:
        print("Not kept for later cells: " + ", ".join(sorted(lost)))
    with open(STATE + ".tmp", "wb") as f:
        pickle.dump(state, f)
    os.replace(STATE + ".tmp", STATE)
    if failed:
        sys.exit(1)
    def clean(v):
        return None if isinstance(v, float) and (math.isnan(v) or math.isinf(v)) else v
    rows = [{k: clean(v) for k, v in r.items()} for r in (shown[-1] if shown else [])]
    with open(out, "w", encoding="utf8") as f:
        json.dump(rows, f, default=str, allow_nan=False)
_basalt_run()
`;
