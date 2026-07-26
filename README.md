# Aislamiento multi-tenant en PostgreSQL, con pruebas negativas

[![CI](https://github.com/LukyPlay/multi-tenant-rls/actions/workflows/ci.yml/badge.svg)](https://github.com/LukyPlay/multi-tenant-rls/actions/workflows/ci.yml)

Implementación mínima y ejecutable del patrón que uso para separar los datos de cada cliente en un SaaS: Row Level Security en la base de datos, no filtros en el controlador. Unas 200 líneas de SQL y TypeScript, 16 pruebas, sin dependencias más allá de `pg` y `vitest`.

Es el patrón descrito en [este case study](https://github.com/LukyPlay/case-studies/blob/main/luckai-saas-multitenant.md), aislado para que se pueda leer y correr en dos minutos.

## El problema

La forma habitual de aislar inquilinos es filtrar en cada consulta:

```sql
select * from documents where tenant_id = $1;
```

Tiene dos defectos. El primero es conocido: hay tantos puntos de fuga como consultas, y basta que un desarrollador olvide la cláusula una vez.

El segundo es el que realmente muerde. Ese filtro **es correcto** y aun así deja pasar al usuario equivocado, porque `tenant_id` responde a "¿de quién es este dato?" y no a "¿este usuario sigue teniendo derecho a verlo?". Un miembro suspendido sigue perteneciendo al inquilino. Un invitado que nunca aceptó, también. La consulta no está mal escrita: la autorización nunca estuvo ahí.

Esto no es hipotético — es la fuga que encontré en una auditoría de mi propio producto, en membresías `suspended` e `invited` que conservaban lectura directa. Ningún endpoint estaba mal. El bug vivía en la política.

## Qué demuestran las pruebas

```
quién puede leer
  ✓ un miembro activo ve los documentos de su inquilino, y solo ésos
  ✓ un miembro suspendido no ve nada
  ✓ un miembro invitado que aún no acepta no ve nada
  ✓ un usuario sin ninguna membresía no ve nada
  ✓ sin identidad en la sesión no se ve nada: falla cerrado
  ✓ un miembro activo de un inquilino no alcanza los documentos del otro
  ✓ un miembro ve sus membresías aunque esté suspendido

quién puede escribir
  ✓ un miembro activo escribe en su propio inquilino
  ✓ no puede insertar un documento en otro inquilino
  ✓ no puede mover un documento propio a otro inquilino
  ✓ un UPDATE sobre documentos ajenos no falla: simplemente no alcanza ninguna fila
  ✓ un DELETE sobre documentos ajenos tampoco alcanza ninguna fila

las garantías del propio mecanismo
  ✓ el dueño de las tablas también queda sujeto a las políticas
  ✓ un superusuario sí las ignora, y por eso la aplicación nunca debe conectar como uno
  ✓ el rol de la aplicación no tiene SUPERUSER ni BYPASSRLS
  ✓ si se apaga RLS, la fuga aparece: la prueba detecta su propio fallo
```

La prueba positiva va primero a propósito: sin ella, todas las negativas pasarían igual con la tabla vacía.

## Correrlo

```bash
docker compose up -d --wait
npm install
npm test
```

O contra cualquier PostgreSQL 13+ al que puedas conectarte como superusuario:

```bash
DATABASE_URL=postgres://usuario@host:5432/basededatos npm test
```

## Las cuatro decisiones que sostienen esto

**`force row level security`, no solo `enable`.** `enable` deja fuera al dueño de la tabla, que normalmente es el rol que corre las migraciones — el mismo que muchas aplicaciones reutilizan para servir tráfico. Sin `force`, las políticas existen y no protegen nada. Hay una prueba que lo afirma, y quitar esa línea la rompe.

**La identidad viaja en un parámetro de sesión.** La capa de aplicación fija `app.user_id` al abrir la transacción y el resto del código escribe SQL normal, sin recordar un `where tenant_id = ...` en cada línea. Se fija con `set_config($1, $2, true)` parametrizado: interpolar la identidad en el texto del SQL sería una inyección en el mecanismo que sostiene todo el aislamiento.

**`with check`, no solo `using`.** `using` gobierna lo que se ve; `with check`, lo que se graba. Sin `with check` en `insert` y `update`, un usuario legítimo de su inquilino puede grabar una fila con el `tenant_id` de otro, o mover una fila existente fuera de su alcance.

**La comprobación de membresía es `security definer` con el `search_path` fijado.** `security definer` para que la política no dependa de los permisos de lectura del que llama: si mañana se revoca el `select` directo sobre `memberships`, las políticas siguen funcionando. Y el `search_path` fijado porque una función `security definer` con el search_path abierto es una escalada de privilegios esperando a que alguien cree un objeto homónimo en un esquema anterior. Por la misma razón la función pertenece a un rol limitado y no a un superusuario.

## Un detalle que sorprende

RLS **no lanza error** cuando actualizas o borras filas que no puedes ver: las filtra en silencio. `update ... where id = $1` sobre un documento ajeno devuelve `rowCount: 0`, no una excepción. Ese cero es la señal de autorización, y el código de la aplicación tiene que leerlo — si asume que el update funcionó, responde 200 sobre algo que nunca ocurrió. Hay dos pruebas que fijan ese comportamiento.

## Verificación por mutación

Una suite que solo se ha visto en verde no demuestra nada: puede estar afirmando trivialidades. Rompí las políticas a propósito, una a la vez, y comprobé qué prueba lo detecta:

| Mutación | Resultado |
|---|---|
| Quitar `force row level security` | falla `el dueño de las tablas también queda sujeto a las políticas` |
| `with check (true)` en el `insert` | falla `no puede insertar un documento en otro inquilino` |
| La política ignora el estado de la membresía | fallan `un miembro suspendido no ve nada` y `un miembro invitado…` |

Cada regresión la caza exactamente la prueba que debería cazarla, y ninguna otra. Eso es lo que hace que el verde signifique algo.

## Modelo de confianza, y lo que este repositorio no cubre

`app.user_id` lo fija el servidor a partir de una sesión ya autenticada. **Nunca** debe llenarse con un valor que venga del cliente: quien controle ese parámetro controla la identidad. RLS protege de errores del código de aplicación y de consultas olvidadas, no de un atacante con acceso SQL directo bajo un rol que él elige.

Fuera de alcance a propósito:

- **Pooling en modo transacción** (PgBouncer y similares). Aquí se usa `set local` dentro de la transacción, que es lo correcto en ese modo; una variante con `set` de sesión filtraría identidad entre peticiones al reciclarse la conexión. Es la trampa más común al llevar este patrón a producción.
- **Auditoría y rendimiento.** Las políticas se evalúan por fila: en tablas grandes hay que revisar los planes y los índices sobre `tenant_id`.
- **Migraciones versionadas, autenticación y el resto de la aplicación.** Este repositorio es el mecanismo de aislamiento, no un esqueleto de proyecto.

---

**In English.** A minimal, runnable implementation of tenant isolation enforced in PostgreSQL through Row Level Security rather than in application controllers, with 16 tests that are mostly negative: suspended members, invited members, missing session identity and cross-tenant writes all resolve to zero rows or a policy violation. It also asserts the guarantees of the mechanism itself — `FORCE` applies to the table owner, the application role holds neither `SUPERUSER` nor `BYPASSRLS`, and disabling RLS makes the leak reappear, proving the suite detects its own failure. Mutation results and the trust model are documented above. Written by **Joshua Angulo González** — [linkedin.com/in/joshuaangulogonzalez](https://www.linkedin.com/in/joshuaangulogonzalez/).
