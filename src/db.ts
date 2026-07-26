import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

const HERE = dirname(fileURLToPath(import.meta.url))
const SQL_DIR = join(HERE, '..', 'sql')

export const CONNECTION_STRING =
    process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres'

export function createPool(): pg.Pool {
    return new pg.Pool({ connectionString: CONNECTION_STRING, max: 4 })
}

/**
 * Aplica el esquema desde cero. Se ejecuta con el rol de migración (superusuario
 * en local y en CI), nunca con el rol de la aplicación.
 */
export async function migrate(pool: pg.Pool): Promise<void> {
    // `drop role` falla si al rol le queda un solo privilegio concedido, así que
    // primero hay que soltar lo que posee. Sin esto el esquema se reconstruye bien
    // la primera vez y revienta la segunda: el error clásico de un `migrate` que
    // solo se probó sobre una base recién creada.
    await pool.query(`
        do $$
        declare
            r text;
        begin
            foreach r in array array['app_user', 'app_owner'] loop
                if exists (select 1 from pg_roles where rolname = r) then
                    execute format('drop owned by %I cascade', r);
                    execute format('drop role %I', r);
                end if;
            end loop;
        end
        $$;

        drop table if exists documents, memberships, tenants cascade;
        drop function if exists is_active_member(uuid);
        drop function if exists app_user_id();
        drop type if exists membership_status;
    `)
    for (const file of ['001_schema.sql', '002_policies.sql']) {
        await pool.query(await readFile(join(SQL_DIR, file), 'utf8'))
    }
}

/**
 * Corre `fn` como la aplicación: rol `app_user` e identidad fijada en
 * `app.user_id`, dentro de una transacción que siempre se revierte para que cada
 * prueba parta del mismo estado.
 *
 * Es el único lugar del código donde se fija la identidad, y se fija con
 * `set_config` parametrizado: interpolarla en el texto del SQL sería una inyección
 * en el mecanismo que sostiene todo el aislamiento.
 */
export async function asAppUser<T>(
    pool: pg.Pool,
    userId: string | null,
    fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
    return inRolledBackTx(pool, async (client) => {
        await client.query('set local role app_user')
        await client.query('select set_config($1, $2, true)', ['app.user_id', userId ?? ''])
        return fn(client)
    })
}

/** Corre `fn` con el rol dueño de las tablas, sin identidad de aplicación. */
export async function asOwner<T>(
    pool: pg.Pool,
    fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
    return inRolledBackTx(pool, async (client) => {
        await client.query('set local role app_owner')
        return fn(client)
    })
}

/** Corre `fn` con el rol de migración, sin revertir: se usa para sembrar datos. */
export async function asMigrator<T>(
    pool: pg.Pool,
    fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
    const client = await pool.connect()
    try {
        return await fn(client)
    } finally {
        client.release()
    }
}

async function inRolledBackTx<T>(
    pool: pg.Pool,
    fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
    const client = await pool.connect()
    try {
        await client.query('begin')
        return await fn(client)
    } finally {
        await client.query('rollback').catch(() => undefined)
        client.release()
    }
}
