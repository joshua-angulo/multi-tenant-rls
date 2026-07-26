-- Aislamiento entre inquilinos, en la base de datos.
--
-- Tres decisiones sostienen este archivo:
--
-- 1. `force row level security`, no solo `enable`. `enable` deja fuera al dueño de
--    la tabla, y el dueño suele ser el rol que corre las migraciones — el mismo que
--    algunas aplicaciones reutilizan para servir tráfico. Sin `force`, las políticas
--    existen y no protegen nada. La prueba `el dueño de las tablas también queda
--    sujeto a las políticas` afirma justamente eso.
--
-- 2. La identidad viaja en un parámetro de sesión, no en cada consulta. La capa de
--    aplicación fija `app.user_id` al abrir la transacción y el resto del código
--    escribe SQL normal, sin recordar un `where tenant_id = ...` en cada línea.
--    Ver «Modelo de confianza» en el README: ese parámetro lo fija el servidor,
--    jamás un valor que venga del cliente.
--
-- 3. La comprobación de membresía es `security definer` para que no dependa de los
--    permisos de lectura del que llama: si mañana se revoca el SELECT directo de
--    `memberships` al rol de la aplicación, las políticas siguen funcionando. Fija
--    su `search_path` porque una función `security definer` con el search_path
--    abierto es una escalada de privilegios esperando a que alguien cree un objeto
--    con el mismo nombre en un esquema anterior.

create or replace function app_user_id() returns uuid
    language sql
    stable
as $$
    select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function is_active_member(target_tenant uuid) returns boolean
    language sql
    stable
    security definer
    set search_path = public, pg_temp
as $$
    select exists (
        select 1
        from memberships m
        where m.tenant_id = target_tenant
          and m.user_id = app_user_id()
          and m.status = 'active'
    )
$$;

alter function app_user_id() owner to app_owner;
alter function is_active_member(uuid) owner to app_owner;

revoke all on function is_active_member(uuid) from public;
grant execute on function app_user_id() to app_user;
grant execute on function is_active_member(uuid) to app_user;

-- Documentos: la superficie que importa.
alter table documents enable row level security;
alter table documents force row level security;

create policy documents_select on documents
    for select using (is_active_member(tenant_id));

-- `with check` en insert y update: sin él, un usuario legítimo de su inquilino
-- podría grabar una fila con el `tenant_id` de otro, o mover una fila existente
-- fuera de su alcance. `using` controla lo que se ve; `with check`, lo que se graba.
create policy documents_insert on documents
    for insert with check (is_active_member(tenant_id));

create policy documents_update on documents
    for update using (is_active_member(tenant_id))
            with check (is_active_member(tenant_id));

create policy documents_delete on documents
    for delete using (is_active_member(tenant_id));

-- Membresías: cada quien ve las suyas, sin importar el estado. Un usuario
-- suspendido necesita poder ver que está suspendido.
alter table memberships enable row level security;
alter table memberships force row level security;

create policy memberships_self on memberships
    for select using (user_id = app_user_id());

-- Inquilinos: visibles solo para quien es miembro activo.
alter table tenants enable row level security;
alter table tenants force row level security;

create policy tenants_member on tenants
    for select using (is_active_member(id));
