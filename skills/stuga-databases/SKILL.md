---
name: stuga-databases
description: Read and change Stuga structured databases — get the schema first, query with one read-only SELECT, and propose row, column and table changes that ride the same review ledger as document edits.
---

# Working with Stuga structured databases

Stuga is at {{STUGA_URL}}. Tools are prefixed `mcp__{{SERVER}}__`. A structured database is a document of `doc_type: "database"` holding typed tables (SQLite underneath). Its rows are NOT in `retrieve` or document search; SQL is the only way to read them.

## Always start with the schema

`databases` with `action: "list"` finds databases you can reach; `action: "schema"` with `database_id` returns tables, columns, physical SQL names and row counts, plus the `instructions` people set for agents on the workspace, its folders and the database, outermost first: follow them when changing the database (`create_database` returns them for a new one). Your schema reads already include any changes you have proposed and that are still pending.

## Reading data

`query` with `database_id`, `sql` and optional `params`:

- ONE read-only SELECT in SQLite dialect. Writes are rejected.
- Use the physical table and column names from the schema. Every table has a `_id` primary key; select it when you plan to update or delete rows.
- JOINs between tables of the same database work. Checkbox columns are 0/1. Dates are `'YYYY-MM-DD'` text, so lexical order is chronological.
- Bind user-supplied values with `?` placeholders and `params` (up to 32).
- Results cap at 1000 rows (`truncated: true`). Aggregate or filter in SQL instead of paginating a dump.
- A row's cells are the whole row EXCEPT its page (below). `query` sees cells only; `_doc_id` is not a SQL column.

Answer questions about counts, totals, "which ones", "latest" and "overdue" with SQL, and cite the database by title.

## Row pages: the body text of a row lives in a document

A row can have a **page** — a prose document linked to that row, where anything longer than a cell belongs (notes, a brief, meeting minutes). Cells stay in the table; the page is the row's body.

- `databases` with `action: "open_page"`, `table` and `row_id` (the row's `_id`, from `query`) returns the page's `doc_id`, creating the page the first time (titled from the row's first text column) and reusing it afterwards. Opening a page is allowed for you; it is a document like any you create.
- Read and edit a page with `markdown` (`action: "read"`, then `write` / `str_replace` / `append`) exactly like any document — the same review applies. Never write a row's long text into a cell: cells cap at 16 KB and a cell edit is one value, not a reviewed passage.
- A page is kept out of the document list (`documents` `action: "list"`, `GET /api/docs`): it belongs to its row, not to the library. Its metadata says so (`page_of` = the database, `page_row` = `<table>.<row>`), and search still finds it. To list one database's pages, `GET /api/docs?page_of=<database id>`.
- To find which rows already have pages, list rows through the REST route `POST /api/databases/<id>/tables/<table>/rows/list` (every row carries `_doc_id`, null when it has none; filter `{ "column_id": "_doc_id", "op": "not_empty" }` for the rows that do; a page the user moved to the Trash shows `_doc_trashed: true` — leave it alone unless asked, `open_page` would bring it back), or simply call `open_page` on the row you need — it returns the existing page rather than making a second one.
- Deleting a row (or a table) moves its pages to the trash; if the deletion is reverted, the pages come back. Trashing the database takes its pages along and restoring it brings them back. The page's title is taken once and is not kept in sync with the row.

## Changing data or schema

All through `databases` with `database_id`; each is a proposal on the run ledger, exactly like a document edit:

- `action: "insert_rows"` with `table` and `rows` (objects keyed by column name). The result carries the new rows' `_id` values; use them in later calls even before they are accepted.
- `action: "update_rows"` with `table` and `updates`: `[{ "_id": …, "values": { … } }]`. Get `_id` from `query`.
- `action: "delete_rows"` with `table` and `row_ids`.
- `action: "add_column"` with `table`, `name`, `type` (text | number | checkbox | date | single_select) and `choices` for single_select.
- `action: "create_table"` with `name` and, for the whole schema in ONE call, `columns: [{ name, type, choices? }]`. `action: "create_database"` with `title`, plus `table` (the starter table's name) and `columns` so it is born with your schema instead of a Name/Notes/Done starter you cannot remove.
- `action: "create_view"` with `table`, `name` and any of `filter`, `sorts`, `group_by`, `hidden_columns` saves a shared way of looking at the table (like a Notion view): a filter is one condition `{ column_id, op, value }` (op: contains | not_contains | eq | ne | gt | gte | lt | lte | empty | not_empty) or a group `{ and: [...] }` / `{ or: [...] }`; `sorts` is `[{ column_id, dir }]`. `action: "update_view"` with `table`, `view` (a view_id or name from the schema) and the fields to change; `name` renames it. Views cannot be deleted by you — ask the user. The schema lists each table's `views`.
- `action: "open_page"` with `table` and `row_id` opens (or creates) the row's page — see "Row pages" above; the page itself is edited with `markdown`.
- `action: "status"` shows what the user decided about your recent changes.

## Bulk data: never through `rows`

`insert_rows` is for a handful of rows you are writing out by hand. NEVER load a dataset with it, however many calls that would take. Use `action: "import"` — the file is validated whole and lands as ONE reviewable, revertible change of up to 50,000 rows:

- **On the user's machine** (Claude Desktop extension, the local stdio server): `import` with `table` and `file`, a path on that machine. A path in your own sandbox such as `/home/claude/…` is NOT visible there.
- **Where you are** (you generated or fetched it, a few thousand rows at most): `import` with `table` and `content`, the file's text itself.
- **Anything bigger, or a file neither of those can deliver**: the refusal you get back carries a link to the table's Import dialog. Give the user that link, attach your file to the reply, say in one sentence why the file has to come from them, and stop. Do NOT look for another way in, and do NOT fall back to `insert_rows`.

Options on `import`: `dry_run: true` returns the verdict (`rows_ready`, `rows_failed`, `errors`, `matched_columns`) without loading anything — do this first for a file you did not generate yourself; `column_map` (file header → column name, or `null` to skip a header); `on_error: "skip_bad_rows"` with `max_bad_rows` lands the good rows without the bad ones (default is abort: nothing loads until every row passes); `date_order: "dmy"|"mdy"` settles dates like `1/4/26` when the column itself does not.

A refused import keeps its upload for an hour: retry it with `import` and `import_id` in place of `file`/`content` — plus corrected options — instead of sending the data again.

File headers match columns by id, physical name or display name (case-insensitively); `_id`-style bookkeeping headers are ignored. Cells are read the way people write them: empty → null; `$1,234.50`, `(12)`, `1 234,5` → number; yes/no/x/1 → checkbox; `2026-01-04`, `1/4/26`, `4 Jan 2026`, `Jan 4, 2026` → date (day/month order inferred per column, and the result's `notes` says when it had to guess); single_select ignores case, spaces, dashes and underscores.

A validation failure comes back as `rows_total`, `rows_failed` and up to 100 `errors` with `row`, `column`, `value`, `code`, `message` and usually a `hint`; nothing was written. A successful import reads **"Proposed — … ONE change waiting"** or **"Applied — imported N rows"**; either way do NOT retry or re-send.

## Reading the result

- **"Proposed — … Do NOT retry"**: SUCCESS, parked for live review. Continue; your schema reads and query results already reflect the pending change.
- **"Applied — …"**: landed immediately; the user was notified and can revert from the table's Activity panel.
- A tool error means that ONE change was refused (bad column, missing row, type mismatch): fix the input and retry that change only. Never guess column names; re-read the schema.
- Batch rows into one `insert_rows` call rather than one call per row: the database allows about 120 mutations per minute and your key shares one request budget with every session using it.

## Ending the turn

Say which changes are pending review and which applied, and link `{{STUGA_URL}}/doc/<database_id>` so the user can open the table.
