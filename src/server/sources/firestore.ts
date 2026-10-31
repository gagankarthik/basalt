import type { Connection, StreamInfo } from "../../lib/types.ts";
import { cursorValue, inferColumns, rowOf, sampleOf, type Doc } from "../../lib/sourceRows.ts";
import type { Source } from "../connectors.ts";
import { NOT_COUNTED, gcpKey, knownFields } from "./common.ts";

const SAMPLE = 200, PAGE = 1000;

export async function firestoreSource(conn: Connection, secret: string): Promise<Source> {
  const { FieldPath, Firestore, GeoPoint, Timestamp, DocumentReference } = await import("@google-cloud/firestore");
  const key = gcpKey(secret), hostName = conn.host?.replace(/^https?:\/\//, "");
  const db = new Firestore({ ...key, ...(conn.database ? { databaseId: conn.database } : {}), ...(hostName ? { host: hostName, ssl: !conn.host!.startsWith("http://") } : {}) });
  const value = (v: unknown): unknown => {
    if (v instanceof Timestamp) return v.toDate();
    if (v instanceof GeoPoint) return { latitude: v.latitude, longitude: v.longitude };
    if (v instanceof DocumentReference) return v.path;
    if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
    if (Array.isArray(v)) return v.map(value);
    if (v && typeof v === "object" && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)]));
    return v;
  };
  const toDoc = (s: { id: string; data(): Doc }): Doc => ({ ...(value(s.data()) as Doc), _id: s.id });
  const samples = new Map<string, Doc[]>(), catalog = new Map<string, StreamInfo>();
  const sample = async (name: string) => {
    if (!samples.has(name)) samples.set(name, (await db.collection(name).limit(SAMPLE).get()).docs.map(toDoc));
    return samples.get(name)!;
  };
  const self: Source = {
    uncounted: true,
    async check() {
      const n = (await db.listCollections()).length;
      return [`Reached Firestore in ${key.projectId}`, `Found ${n} top-level collection${n === 1 ? "" : "s"}`, "Basalt only runs queries. Google doesn't tell a client what else its key allows, so give this service account the Cloud Datastore Viewer role."];
    },
    async discover() {
      const out: StreamInfo[] = [];
      for (const c of await db.listCollections()) {
        const info: StreamInfo = { name: c.id, primaryKey: "_id", columns: inferColumns(await sample(c.id), ["_id"]) };
        catalog.set(c.id, info);
        out.push(info);
      }
      return out;
    },
    async sample(stream, column) { return sampleOf(await sample(stream), column); },
    // An aggregation is charged by the documents it passes
    count: async () => { throw new Error(NOT_COUNTED); },
    async read(stream, { columns, cursor, after, maxRows, inclusive, withheld }, onBatch) {
      const known = await knownFields(stream, catalog, columns, self), hold = new Set(withheld?.map((w) => w.toLowerCase()));
      let query: FirebaseFirestore.Query = db.collection(stream);
      // Ordering by a field skips documents without it, so the first read goes by document name
      if (cursor && cursor !== "_id" && after) query = query.where(cursor, inclusive ? ">=" : ">", cursorValue(catalog.get(stream)?.columns.find((c) => c.name === cursor)?.type, after)).orderBy(cursor);
      query = query.orderBy(FieldPath.documentId());
      if (cursor === "_id" && after) query = query.startAfter(after);
      let last: FirebaseFirestore.QueryDocumentSnapshot | undefined, left = maxRows ?? Infinity;
      for (;;) {
        const page = await (last ? query.startAfter(last) : query).limit(Math.min(PAGE, left)).get();
        if (page.empty) return;
        left -= page.size;
        await onBatch(page.docs.map((d) => rowOf(toDoc(d), columns, known, hold)));
        if (page.size < PAGE || left <= 0) return;
        last = page.docs[page.size - 1];
      }
    },
    close: () => db.terminate(),
  };
  return self;
}
