import type pg from 'pg'

import { asMigrator } from './db.js'

/**
 * Dos inquilinos y cuatro usuarios que cubren los casos que importan:
 * un miembro activo de cada inquilino, uno suspendido y uno invitado.
 */
export const FIXTURE = {
    tenantAcme: '11111111-1111-4111-8111-111111111111',
    tenantGlobex: '22222222-2222-4222-8222-222222222222',
    activeInAcme: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    activeInGlobex: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    suspendedInAcme: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    invitedInAcme: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    strangerUser: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
} as const

export async function seed(pool: pg.Pool): Promise<void> {
    await asMigrator(pool, async (client) => {
        await client.query(
            `insert into tenants (id, name) values ($1, 'Acme'), ($2, 'Globex')`,
            [FIXTURE.tenantAcme, FIXTURE.tenantGlobex],
        )

        await client.query(
            `insert into memberships (user_id, tenant_id, status) values
                 ($1, $5, 'active'),
                 ($2, $6, 'active'),
                 ($3, $5, 'suspended'),
                 ($4, $5, 'invited')`,
            [
                FIXTURE.activeInAcme,
                FIXTURE.activeInGlobex,
                FIXTURE.suspendedInAcme,
                FIXTURE.invitedInAcme,
                FIXTURE.tenantAcme,
                FIXTURE.tenantGlobex,
            ],
        )

        await client.query(
            `insert into documents (tenant_id, title) values
                 ($1, 'Contrato Acme'),
                 ($1, 'Nómina Acme'),
                 ($2, 'Contrato Globex')`,
            [FIXTURE.tenantAcme, FIXTURE.tenantGlobex],
        )
    })
}
