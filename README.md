# Keeping each customer's data separate in PostgreSQL

[![CI](https://github.com/joshua-angulo/saas-data-isolation/actions/workflows/ci.yml/badge.svg)](https://github.com/joshua-angulo/saas-data-isolation/actions/workflows/ci.yml)

In a SaaS, many companies share one database, and each one must only ever see its own data. This repo shows how I enforce that inside PostgreSQL itself, using Row Level Security, so a missing filter in the app can't leak another customer's records. It's about 200 lines of SQL and TypeScript with 16 tests, and it only depends on `pg` and `vitest`.

It's the pattern from [this case study](https://github.com/joshua-angulo/case-studies/blob/main/luckagents.md), pulled out on its own so you can read it and run it in about two minutes.

## The problem

The usual way to isolate tenants is to filter every query:

```sql
select * from documents where tenant_id = $1;
```

This has two problems. The first is well known: every query is a place to leak, and it only takes one forgotten clause.

The second one is easier to miss. The filter above **is correct** and still lets the wrong user in, because `tenant_id` answers "whose data is this?" while the real question is "is this user still allowed to see it?". A suspended member still belongs to the tenant, and so does an invited user who never accepted. The query is fine. The authorization check was never there.

I found exactly this leak while auditing my own product: `suspended` and `invited` memberships could still read data directly. Every endpoint was correct; the bug was in the policy.

## What the tests prove

```
who can read
  ✓ an active member sees their tenant's documents, and only those
  ✓ a suspended member sees nothing
  ✓ an invited member who has not accepted yet sees nothing
  ✓ a user with no membership sees nothing
  ✓ with no identity in the session nothing is visible: fail closed
  ✓ an active member of one tenant cannot reach the other tenant's documents
  ✓ a member can see their own memberships even when suspended

who can write
  ✓ an active member writes to their own tenant
  ✓ cannot insert a document into another tenant
  ✓ cannot move an own document into another tenant
  ✓ an UPDATE on someone else's documents does not error: it simply reaches no rows
  ✓ a DELETE on someone else's documents reaches no rows either

guarantees of the mechanism itself
  ✓ the table owner is also subject to the policies
  ✓ a superuser does bypass them, which is why the app must never connect as one
  ✓ the application role has neither SUPERUSER nor BYPASSRLS
  ✓ if RLS is turned off, the leak appears: the suite detects its own failure
```

The positive test comes first on purpose. Without it, every negative test would also pass against an empty table.

## Run it

```bash
docker compose up -d --wait
npm install
npm test
```

Or against any PostgreSQL 13+ you can reach as a superuser:

```bash
DATABASE_URL=postgres://user@host:5432/database npm test
```

## The four decisions that hold this together

**`force row level security` in addition to `enable`.** `enable` alone skips the table owner, which is usually the role that runs migrations and often the same role the application uses to serve traffic. Without `force`, the policies exist but protect nothing. A test checks this, and removing that line breaks it.

**Identity travels in a session parameter.** The application sets `app.user_id` when it opens the transaction, and the rest of the code writes plain SQL without adding `where tenant_id = ...` everywhere. It's set with a parameterized `set_config($1, $2, true)`, because building that string by hand would open an injection point in the one mechanism the whole isolation depends on.

**`with check` as well as `using`.** `using` controls what you can see; `with check` controls what you can write. Without `with check` on `insert` and `update`, a legitimate user of one tenant can write a row with another tenant's `tenant_id`, or move an existing row out of their own reach.

**The membership check is `security definer` with a pinned `search_path`.** `security definer` keeps the policy independent of the caller's read permissions, so if direct `select` on `memberships` is revoked later, the policies keep working. The `search_path` is pinned because a `security definer` function with an open search path lets someone escalate privileges by creating an object with the same name in an earlier schema. For the same reason, the function is owned by a limited role instead of a superuser.

## A surprising detail

RLS **doesn't raise an error** when you update or delete rows you can't see. It filters them out silently, so `update ... where id = $1` on someone else's document returns `rowCount: 0` instead of throwing. That zero is your authorization signal, and the application has to check it. Otherwise it returns 200 for an update that never happened. Two tests lock in this behavior.

## Mutation check

If you've only ever seen a test suite pass, you don't know whether it tests anything. So I broke the policies on purpose, one at a time, and checked which test caught each break:

| Mutation | Result |
|---|---|
| Remove `force row level security` | fails `the table owner is also subject to the policies` |
| `with check (true)` on `insert` | fails `cannot insert a document into another tenant` |
| The policy ignores membership status | fails `a suspended member sees nothing` and `an invited member…` |

Each break is caught by the test meant to catch it and by no other, so a passing run actually tells you something.

## Trust model, and what this repository does not cover

The server sets `app.user_id` from a session it has already authenticated. It must **never** take a value sent by the client, since whoever controls that parameter controls the identity. RLS protects you from mistakes in application code and forgotten filters. An attacker who can run SQL under a role of their choosing is a different problem.

Left out on purpose:

- **Transaction-mode pooling** (PgBouncer and similar). This repo uses `set local` inside the transaction, which is right for that mode. A session-level `set` would leak identity between requests when connections get reused, and it's the most common mistake when this pattern goes to production.
- **Auditing and performance.** Policies run per row, so on large tables check the query plans and the indexes on `tenant_id`.
- **Versioned migrations, authentication and the rest of an application.** This repo covers the isolation mechanism only.

---

**En español.** Implementación mínima y ejecutable del aislamiento multi-tenant en PostgreSQL con Row Level Security, en lugar de filtros en el controlador, con 16 pruebas en su mayoría negativas: miembros suspendidos, invitados, sesiones sin identidad y escrituras entre inquilinos terminan en cero filas o en una violación de política. También verifica el propio mecanismo (`FORCE` aplica al dueño de la tabla, el rol de la aplicación no tiene `SUPERUSER` ni `BYPASSRLS`, y al apagar RLS la fuga reaparece). Escrito por **Joshua Angulo González**, [linkedin.com/in/joshuaangulogonzalez](https://www.linkedin.com/in/joshuaangulogonzalez/).
