---
name: stuga-databases
description: Read and change Stuga structured databases — get the schema first, query with one read-only SELECT, and propose row, column and table changes with databases_add and databases_change, which ride the same review ledger as document edits.
---

# Working with Stuga structured databases

Stuga is at {{STUGA_URL}}. Tools are prefixed `mcp__{{SERVER}}__`. A structured database is a document of `doc_type: "database"` holding typed tables (SQLite underneath). Its rows are NOT in `retrieve` or `search`; SQL is the only way to read them.

Every call below takes the `workspace_id` of the workspace the database is in: the one its listing or search hit named. For a new database, use the workspace the user names; when the key reaches several and they named none, ask which.

## Always start with the schema

`databases` with `action: "list"` finds the databases you can reach in a workspace; `action: "schema"` with `database_id` returns tables, columns, physical SQL names, row counts and saved views, plus the `instructions` people set for agents on the workspace, its folders and the database, outermost first: follow them when changing the database (`databases_add` `action: "create_database"` returns them for a new one). Your schema reads already include any changes you have proposed and that are still pending.

## Reading data

`query` with `workspace_id`, `database_id`, `sql` and optional `params`:

- ONE read-only SELECT in SQLite dialect. Writes are rejected.
- Use the physical table and column names from the schema. Every table has a `_id` primary key; select it when you plan to update or delete rows, or to find a row's page.
- JOINs between tables of the same database work. Checkbox columns are 0/1. Dates are `'YYYY-MM-DD'` text, so lexical order is chronological.
- Bind user-supplied values with `?` placeholders and `params` (up to 32).
- Results cap at 1000 rows (`truncated: true`). Aggregate or filter in SQL instead of paginating a dump.
- A row's cells are the whole row EXCEPT its page (below). `query` sees cells only; `_doc_id` is not a SQL column.

Answer questions about counts, totals, "which ones", "latest" and "overdue" with SQL, and cite the database by title.

## Row pages: the body text of a row lives in a document

A row can have a **page** — a prose document linked to that row, where anything longer than a cell belongs (notes, a brief, meeting minutes). Cells stay in the table; the page is the row's body.

- `databases` with `action: "page"`, `database_id`, `table` and `row_id` (the row's `_id`, from `query`) returns the page's `doc_id`, or `null` when the row has none or its page is in the Trash. It creates nothing.
- `databases_add` with `action: "open_page"`, `database_id`, `table` and `row_id` returns the page, creating it the first time (titled from the row's first text column) and reusing it afterwards. It also brings a page back from the Trash: do that only when the user asks for it.
- Read and edit a page with `markdown`, `markdown_edit` and `markdown_append` exactly like any document — the same review applies. Never write a row's long text into a cell: cells cap at 16 KB and a cell edit is one value, not a reviewed passage.
- A page is kept out of `docs` `action: "list"`: it belongs to its row, not to the library. Its metadata says so (`page_of` = the database, `page_row` = `<table>.<row>`), and search still finds it.
- Deleting a row (or a table) moves its pages to the Trash; if the deletion is reverted, the pages come back. Trashing the database takes its pages along and restoring it brings them back. The page's title is taken once and is not kept in sync with the row.

## Adding: `databases_add`

Each is a proposal on the run ledger, exactly like a document edit. All take `workspace_id`; all but `create_database` take `database_id`.

- `action: "insert_rows"` with `table` and `rows` (objects keyed by column name). The result carries the new rows' `_id` values; use them in later calls even before they are accepted.
- `action: "add_column"` with `table`, `name`, `type` (text | number | checkbox | date | single_select), `choices` for single_select, and `description` whenever the name alone leaves units, codes or conventions ambiguous.
- `action: "create_table"` with `name` and, for the whole schema in ONE call, `columns: [{ name, type, choices?, description? }]`. `action: "create_database"` with `title`, plus `table` (the starter table's name) and `columns` so it is born with your schema instead of a Name/Notes/Done starter you cannot remove.
- `action: "create_view"` with `table`, `name` and any of `filter`, `sorts`, `group_by`, `hidden_columns` saves a shared way of looking at the table (like a Notion view): a filter is one condition `{ column_id, op, value }` (op: contains | not_contains | eq | ne | gt | gte | lt | lte | empty | not_empty) or a group `{ and: [...] }` / `{ or: [...] }`; `sorts` is `[{ column_id, dir }]`. The schema lists each table's `views`.
- `action: "import"` and `action: "start_import"` load a file — see "Bulk data" below.
- `action: "open_page"` — see "Row pages" above.

## Changing: `databases_change`

Each is a proposal on the run ledger. All take `workspace_id`, `database_id` and `table`.

- `action: "update_rows"` with `updates`: `[{ "_id": …, "values": { … } }]`. Get `_id` from `query`.
- `action: "delete_rows"` with `row_ids`.
- `action: "update_view"` with `view` (a view_id or name from the schema) and the fields to change; `name` renames it. Views cannot be deleted by you — ask the user.

`databases` with `action: "status"` and `database_id` shows what the user decided about your recent changes.

## Bulk data: never through `rows`

`insert_rows` is for a handful of rows you are writing out by hand. NEVER load a dataset with it, however many calls that would take. Import instead — the file is validated whole and lands as ONE reviewable, revertible change of up to 50,000 rows:

- **A file you can hand over as text** (you generated or fetched it, a few thousand rows at most): `databases_add` `action: "import"` with `table` and `content`, the file's text itself.
- **A file on the machine you run on, when you can run a command there**: `databases_add` `action: "start_import"` with `table` (and `format`, csv or jsonl) returns an `upload_url`, an `upload_path` and an `import_id`. PUT the whole file to `upload_url` (`curl -T data.csv '<upload_url>'`; if that address does not answer from here, use `{{STUGA_URL}}` followed by `upload_path`), then call `databases_add` `action: "import"` with that `import_id`. The signed URL is the credential and works once.
- **Anything neither of those can deliver**: the refusal you get back carries a link to the table's Import dialog (`start_import` returns it as `import_page_url`). Give the user that link, attach your file to the reply, say in one sentence why the file has to come from them, and stop. Do NOT look for another way in, and do NOT fall back to `insert_rows`.

Options on `import`: `dry_run: true` returns the verdict (`rows_ready`, `rows_failed`, `errors`, `matched_columns`) without loading anything — do this first for a file you did not generate yourself; `column_map` (file header → column name, or `null` to skip a header); `on_error: "skip_bad_rows"` with `max_bad_rows` lands the good rows without the bad ones (default is abort: nothing loads until every row passes); `date_order: "dmy"|"mdy"` settles dates like `1/4/26` when the column itself does not.

A refused import keeps its upload for an hour: retry it with `import` and `import_id` in place of `content` — plus corrected options — instead of sending the data again.

File headers match columns by id, physical name or display name (case-insensitively); `_id`-style bookkeeping headers are ignored. Cells are read the way people write them: empty → null; `$1,234.50`, `(12)`, `1 234,5` → number; yes/no/x/1 → checkbox; `2026-01-04`, `1/4/26`, `4 Jan 2026`, `Jan 4, 2026` → date (day/month order inferred per column, and the result's `notes` says when it had to guess); single_select ignores case, spaces, dashes and underscores.

A validation failure comes back as `rows_total`, `rows_failed` and up to 100 `errors` with `row`, `column`, `value`, `code`, `message` and usually a `hint`; nothing was written. A successful import reads **"Proposed — … ONE change waiting"** or **"Applied — imported N rows"**; either way do NOT retry or re-send.

## Reading the result

- **"Proposed — …"**: SUCCESS, parked for review. Do NOT retry. Continue; your schema reads and query results already reflect the pending change.
- **"Applied — …"**: landed immediately; the user was notified and can revert from the table's Activity panel.
- A tool error means that ONE change was refused (bad column, missing row, type mismatch): fix the input and retry that change only. Never guess column names; re-read the schema.
- Batch rows into one `insert_rows` call rather than one call per row: the database allows about 120 mutations per minute and your key shares one request budget with every session using it.
- A read-only key is offered only the reading tools, so `databases_add` and `databases_change` are missing: tell the user what you would change.

## Ending the turn

Say which changes are pending review and which applied, and link `{{STUGA_URL}}/doc/<database_id>` so the user can open the table.
