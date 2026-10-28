import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";
import type { Database, Statement } from "./core.ts";
export function sqliteDatabase(path: string): Database {
  const sqlite = new DatabaseSync(path);
  if (path !== ":memory:" && existsSync(path)) chmodSync(path, 0o600);
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  const wrap = (
    sql: string,
    values: (string | number | null)[] = [],
  ): Statement => ({
    bind(...v) {
      return wrap(sql, v);
    },
    async run() {
      const r = sqlite.prepare(sql).run(...values);
      return { meta: { changes: Number(r.changes) } };
    },
    async all<T>() {
      return { results: sqlite.prepare(sql).all(...values) as T[] };
    },
    async first<T>() {
      return (sqlite.prepare(sql).get(...values) ?? null) as T | null;
    },
  });
  return {
    prepare: (sql) => wrap(sql),
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
