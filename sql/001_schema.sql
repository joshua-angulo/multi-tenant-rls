-- Esquema mínimo de un SaaS multi-tenant: inquilinos, membresías con estado y
-- documentos que pertenecen a un inquilino.
--
-- El estado de la membresía es el centro de todo. Un usuario `invited` todavía no
-- aceptó; un usuario `suspended` fue dado de baja. Ninguno de los dos debe leer
-- nada, y ésa es exactamente la clase de fuga que un `where tenant_id = $1` en el
-- controlador no detecta: el filtro por inquilino es correcto y aun así el
-- suspendido lee.

-- Dos roles, ninguno con privilegios de más:
--
--   app_owner  dueño de las tablas y de la función de comprobación. No es
--              superusuario a propósito: una función `security definer` propiedad
--              de un superusuario es una escalada de privilegios esperando un
--              descuido.
--   app_user   el rol con el que conecta la API. Sin SUPERUSER y sin BYPASSRLS;
--              cualquiera de los dos apaga en silencio todas las políticas.
--
-- Ambas ausencias están afirmadas en `test/isolation.test.ts`, no confiadas al
-- criterio de quien revise el siguiente cambio.
create role app_owner nologin;
create role app_user nologin;

create type membership_status as enum ('active', 'invited', 'suspended');

create table tenants (
    id   uuid primary key default gen_random_uuid(),
    name text not null
);

create table memberships (
    user_id   uuid not null,
    tenant_id uuid not null references tenants (id) on delete cascade,
    status    membership_status not null,
    primary key (user_id, tenant_id)
);

create table documents (
    id        uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id) on delete cascade,
    title     text not null,
    body      text not null default ''
);

create index documents_tenant_idx on documents (tenant_id);

alter type membership_status owner to app_owner;
alter table tenants owner to app_owner;
alter table memberships owner to app_owner;
alter table documents owner to app_owner;

grant usage on schema public to app_user;
grant select, insert, update, delete on tenants, memberships, documents to app_user;
