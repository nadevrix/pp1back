# pollar-backend — Documentación de API

Next.js 16 corriendo en el **puerto 3000**. Todos los endpoints son API Routes bajo `/src/app/api/`. No hay páginas de frontend relevantes — los archivos `page.tsx` y `layout.tsx` son placeholders del scaffolding de Next.js.

---

## Variables de entorno requeridas

| Variable | Descripción |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key — bypasea RLS, solo en servidor |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` para testnet |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` para testnet |
| `STELLAR_USDC_ISSUER` | Issuer del USDC en la red. Testnet: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| `STELLAR_NETWORK` | `TESTNET` o `MAINNET` — se devuelve al SDK en cada intent |
| `ADMIN_SECRET_KEY` | Header `X-Admin-Secret` para endpoints admin |
| `CRON_SECRET` | Header `x-cron-secret` para el endpoint del procesador |
| `NEXT_PUBLIC_CHECKOUT_BASE_URL` | Base URL del hosted checkout (ver `checkout_url` en `/api/sdk/pay`) |
| `SUPPORT_PHONE` | Número de soporte devuelto en anomalías |
| `SUPPORT_MESSAGE` | Mensaje de soporte devuelto en anomalías |

Las secret keys de las pool wallets se guardan **en plaintext** en `public.wallets.secret_key`. El backend las lee directo y firma con `Keypair.fromSecret()`. Para que esto sea seguro, restringí el acceso a la Service Role Key de Supabase a un grupo pequeño y mantené el repo privado.

---

## Endpoints

### POST /api/projects/create

Crea un proyecto para un comercio. Devuelve un `api_key` UUID que el comercio usa en el SDK.

**No requiere autenticación por ahora.**

⚠️ TODO: Este endpoint auto-crea el perfil del `merchant_id` si no existe en `profiles`. Esto es un bypass de desarrollo — en producción el `merchant_id` debe venir de un sistema de auth real y el perfil ya debe existir.

**Body:**
```json
{
    "merchant_id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Mi Tienda",
    "reason": "Pagos USDC en Stellar",
    "payout_wallet": "GDESTINO..."
}
```

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `merchant_id` | UUID | Sí | ID del comercio. Debe existir en `profiles` (o se crea automáticamente en dev) |
| `name` | string | Sí | Nombre del proyecto |
| `reason` | string | Sí | Motivo o descripción del proyecto |
| `payout_wallet` | string | No | Wallet Stellar del comercio para payouts finales (informativo, no usado actualmente) |

**Respuesta 201:**
```json
{
    "success": true,
    "message": "Project created successfully",
    "project": {
        "id": "a1b2c3d4-...",
        "api_key": "f9e8d7c6-...",
        "name": "Mi Tienda"
    }
}
```

**Fallos:**
| Status | Cuándo |
|---|---|
| 400 | Falta `merchant_id`, `name` o `reason` |
| 500 | Error de Supabase |

---

### POST /api/sdk/pay

Genera un intent de pago. Asigna una wallet del pool via round robin atómico y crea la transacción en la DB.

**Body:**
```json
{
    "api_key": "f9e8d7c6-...",
    "amount_expected": "2.00"
}
```

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `api_key` | UUID string | Sí | API key del proyecto |
| `amount_expected` | string o number | Sí | Monto en USDC. Mínimo: `0.01`. Máximo: `1000000` |

Internamente:
1. Valida `api_key` contra la tabla `projects`
2. Llama a la RPC `claim_wallet(project_id, locked_until)` en Postgres — ver `DATABASE.md`
3. Inserta la transacción con `status = 'pending'` y `expires_at = ahora + 15 min`
4. Si falla la inserción de la transacción, libera la wallet (`is_locked = false`)

**Respuesta 200:**
```json
{
    "success": true,
    "data": {
        "transaction_id": "c3d4e5f6-...",
        "wallet_address": "GCXXX...WALLET",
        "amount": 2,
        "asset": "USDC",
        "expires_at": "2026-04-30T14:30:00.000Z",
        "network": "TESTNET"
    }
}
```

**Fallos:**
| Status | Cuándo |
|---|---|
| 400 | Falta `api_key` o `amount_expected`, o monto fuera del rango permitido |
| 401 | `api_key` inválida o inexistente |
| 503 | No hay wallets disponibles en el pool (todas locked) |
| 500 | Error de Supabase o Stellar |

---

### GET /api/sdk/status

Devuelve el estado actual de una transacción. El SDK usa este endpoint para polling.

**Query params:**
```
GET /api/sdk/status?transaction_id=c3d4e5f6-...&api_key=f9e8d7c6-...
```

| Param | Requerido | Descripción |
|---|---|---|
| `transaction_id` | Sí | ID de la transacción devuelta por `/api/sdk/pay` |
| `api_key` | Sí | API key del proyecto. Verifica que la transacción pertenece a este proyecto |

**Respuesta 200:**
```json
{
    "success": true,
    "data": {
        "transaction_id": "c3d4e5f6-...",
        "status": "pending",
        "amount_expected": "2.00",
        "amount_paid": "1.50",
        "remaining": "0.50",
        "asset": "USDC",
        "wallet_address": "GCXXX...WALLET",
        "expires_at": "2026-04-30T14:30:00.000Z",
        "time_remaining_seconds": 487,
        "is_expired": false,
        "created_at": "2026-04-30T14:15:00.000Z"
    }
}
```

Cuando `status` es `overpaid`, `underpaid`, `anomaly` o `late_anomaly`, la respuesta incluye un campo adicional:
```json
{
    "data": {
        "...campos normales...",
        "support": {
            "contact": "+000 00000000",
            "message": "Contact Pollar Pay support for refund assistance."
        }
    }
}
```

Para `overpaid`, el mensaje de soporte también incluye el excedente:
```
"Payment completed with excess of 0.50 USDC. Contact Pollar Pay support..."
```

**Estados posibles de `status`:**

| Estado | Significado |
|---|---|
| `pending` | Esperando pago. `amount_paid` se actualiza con pagos parciales |
| `completed` | Pago exacto recibido y enviado a treasury |
| `overpaid` | Se recibió más de lo esperado. No hay reembolso automático |
| `underpaid` | Expiró con pago parcial. Los fondos parciales se enviaron a treasury |
| `expired` | Expiró sin ningún pago |
| `refunded` | Un admin procesó un reembolso manual desde treasury |
| `anomaly` | Reservado para casos edge (no generado actualmente por el procesador) |
| `late_anomaly` | Reservado para casos edge (no generado actualmente por el procesador) |

**Fallos:**
| Status | Cuándo |
|---|---|
| 400 | Faltan query params |
| 401 | `api_key` inválida |
| 404 | `transaction_id` no existe o no pertenece a este proyecto |
| 500 | Error de Supabase |

---

### GET /api/cron/check-payments

Ejecuta el procesador de pagos. Consulta todas las transacciones `pending` en la DB, verifica en Horizon si recibieron USDC, y actualiza los estados.

**Header requerido:**
```
x-cron-secret: <CRON_SECRET del .env>
```

Llamar cada 5-10 segundos desde un scheduler externo. Sin ese header (o con valor incorrecto) devuelve 401.

**Cómo funciona internamente** — ver sección [Payment Processor](#payment-processor) más abajo.

**Respuesta 200:**
```json
{
    "success": true,
    "processed": 3,
    "results": [
        { "id": "c3d4e5f6-...", "status": "waiting" },
        { "id": "d4e5f6g7-...", "status": "partial", "received": 1.5, "expected": 2 },
        { "id": "e5f6g7h8-...", "status": "completed", "received": 2 }
    ]
}
```

Los `status` dentro de `results` son los del procesador interno, no los de la transacción:

| Status en results | Significado |
|---|---|
| `waiting` | Sin pagos nuevos detectados |
| `partial` | Pago parcial detectado, `amount_paid` actualizado |
| `completed` | Pago exacto — transacción marcada `completed` |
| `overpaid` | Excedente — transacción marcada `overpaid` |
| `expired` | Timer expiró sin pago — marcada `expired` |
| `underpaid` | Timer expiró con pago parcial — marcada `underpaid` |
| `error` | Error al procesar esa transacción específica |

**Fallos:**
| Status | Cuándo |
|---|---|
| 401 | Header `x-cron-secret` ausente o incorrecto |
| 500 | Error general del procesador |

---

### GET /api/admin/dashboard

KPIs del sistema en tiempo real.

**Header requerido:**
```
X-Admin-Secret: <ADMIN_SECRET_KEY del .env>
```

**Respuesta 200:**
```json
{
    "success": true,
    "data": {
        "pool": {
            "total": 100,
            "available": 97,
            "locked": 3
        },
        "treasury": {
            "count": 1,
            "public_key": "GTREASURY..."
        },
        "transactions": {
            "total": 450,
            "completed": 420,
            "pending": 3,
            "anomalies": 5,
            "last_24h": 28
        },
        "volume": {
            "total_processed_usdc": "8431.50"
        }
    }
}
```

`volume.total_processed_usdc` suma `amount_paid` de transacciones `completed` y `overpaid`.

---

### GET /api/admin/wallets

Lista todas las wallets del pool y treasury.

**Header requerido:** `X-Admin-Secret`

**Respuesta 200:**
```json
{
    "success": true,
    "data": {
        "total_pool": 100,
        "pool_locked": 2,
        "pool_available": 98,
        "treasury_count": 1,
        "wallets": [
            {
                "public_key": "GCXXX...",
                "wallet_type": "pool",
                "is_locked": false,
                "locked_until": null,
                "last_project_id": "a1b2c3...",
                "created_at": "2026-04-30T..."
            }
        ]
    }
}
```

---

### POST /api/admin/wallets

Crea una nueva wallet de pool: genera keypair → Friendbot (testnet) → USDC trustline → inserta en DB.

**Header requerido:** `X-Admin-Secret`

**Body:** `{}` (vacío — el keypair se genera en el servidor)

⚠️ Este endpoint no asigna `wallet_index`. Para que la wallet entre al round robin hay que asignarle un índice manualmente en la DB después de crearla. El seed script (`scripts/seed-wallets.ts`) sí asigna el índice correctamente — úsalo para el setup inicial.

**Respuesta 201:**
```json
{
    "success": true,
    "message": "Pool wallet created with USDC trustline",
    "wallet": {
        "public_key": "GNUEVA...",
        "wallet_type": "pool",
        "is_locked": false,
        "note": "..."
    }
}
```

**Fallos:**
| Status | Cuándo |
|---|---|
| 401 | Header admin incorrecto |
| 503 | Friendbot no responde (testnet sobrecargado) |
| 500 | Error al crear trustline o insertar en DB |

---

### DELETE /api/admin/wallets

Elimina una wallet del pool de rotación. La cuenta Stellar sigue existiendo en la blockchain.

**Header requerido:** `X-Admin-Secret`

**Body:**
```json
{
    "public_key": "GCXXX..."
}
```

Solo funciona si:
- La wallet existe en la DB y es de tipo `pool`
- `is_locked = false`
- No tiene transacciones con `status = 'pending'`

**Respuesta 200:**
```json
{
    "success": true,
    "message": "Wallet removed from pool rotation",
    "note": "The Stellar account still exists. Funds can be recovered manually if needed."
}
```

**Fallos:**
| Status | Cuándo |
|---|---|
| 400 | Falta `public_key` |
| 401 | Header admin incorrecto |
| 403 | Intentar eliminar la wallet treasury |
| 404 | Wallet no encontrada |
| 409 | Wallet locked o con transacciones pending |
| 500 | Error de Supabase |

---

### POST /api/admin/refund

Envía USDC desde la treasury a una wallet de destino. Marca la transacción como `refunded` si el envío en Stellar es exitoso.

**Header requerido:** `X-Admin-Secret`

**Body:**
```json
{
    "transaction_id": "c3d4e5f6-...",
    "destination_wallet": "GDESTINO...",
    "amount": "0.50"
}
```

| Campo | Descripción |
|---|---|
| `transaction_id` | ID de la transacción a reembolsar |
| `destination_wallet` | Dirección Stellar del cliente que recibe el reembolso |
| `amount` | Monto a reembolsar en USDC (puede ser el total o parcial) |

Internamente usa `dispatchRefundFromTreasury()` en `src/lib/forwarder.ts`. Decripta la clave privada de la treasury, construye la transacción Stellar y la firma.

**Respuesta 200:**
```json
{
    "success": true,
    "message": "Refund successfully completed",
    "hash": "abc123..."
}
```

**Fallos:**
| Status | Cuándo |
|---|---|
| 400 | Faltan campos requeridos, o `amount <= 0` |
| 401 | Header admin incorrecto |
| 404 | `transaction_id` no existe |
| 409 | La transacción ya fue reembolsada (`status = 'refunded'`) |
| 500 | Error en Stellar (fondos insuficientes en treasury, timeout, etc.) |

---

## Payment Processor

**Archivo:** `src/lib/payment-processor.ts`

Función principal: `processPendingPayments()`

Busca todas las transacciones con `status = 'pending'` y para cada una:

1. **`getUsdcReceivedSince(walletPubkey, created_at)`** — consulta Horizon con paginación. Itera los registros de pagos de esa cuenta, filtra por:
   - `type = 'payment'`
   - `to = walletPubkey` (descarta pagos enviados desde la wallet)
   - `asset_code = 'USDC'` con el issuer correcto
   - `created_at >= transaction.created_at` (descarta pagos anteriores al intent)

   Suma todos los montos válidos. Si la cuenta no existe en Horizon todavía (404), devuelve 0.

2. **Compara** `totalReceived` con `amount_expected`.

3. **Actualiza** la DB y desbloquea la wallet según los casos documentados en `README.md`.

4. **`forwardToTreasury(walletPubkey, amount, context)`** — si hay fondos que mover:
   - Decripta la clave privada de la wallet pool desde la DB
   - Carga la cuenta en Horizon
   - Construye y firma una transacción Stellar de pago a la treasury
   - Retorna el hash del tx

   Si `forwardToTreasury` falla (por ejemplo, error de red con Horizon), el error se loggea pero **no se revierte el estado de la transacción**. La transacción queda en su estado final (`completed`, `overpaid`, etc.) pero los fondos siguen en la wallet pool. Esto es un edge case que requiere intervención manual.

5. **`unlockWallet(walletPubkey)`** — setea `is_locked = false` y `locked_until = null`. La wallet vuelve al pool disponible.

---

## Round Robin de wallets

El pool tiene 100 wallets con índices `0..99`. La posición actual se guarda en `config.rr_last_index`.

La RPC `claim_wallet()` en Postgres garantiza que dos requests concurrentes nunca obtienen la misma wallet:

```
Request A y Request B llegan al mismo tiempo
│
├── A: SELECT rr_last_index FOR UPDATE → obtiene lock, lee 42
│   B: SELECT rr_last_index FOR UPDATE → bloqueada, espera
│
├── A: busca wallet_index = 43 → disponible → la lockea
│   A: actualiza rr_last_index = 43
│   A: COMMIT
│
└── B: ahora puede leer → lee 43
    B: busca wallet_index = 44 → disponible → la lockea
    B: actualiza rr_last_index = 44
    B: COMMIT
```

Si la wallet del índice siguiente está locked, la RPC prueba `44`, `45`... hasta completar el ciclo. Si las 100 están ocupadas, devuelve `NULL` y el endpoint responde 503.

---

## Librerías relevantes

| Archivo | Rol |
|---|---|
| `src/lib/supabase.ts` | Cliente Supabase con `SERVICE_ROLE_KEY` — bypasea RLS |
| `src/lib/forwarder.ts` | `forwardToTreasury()`, `dispatchRefundFromTreasury()` — transacciones Stellar |
| `src/lib/admin-auth.ts` | `validateAdminAuth()` — valida header `X-Admin-Secret` |
| `src/lib/payment-processor.ts` | `processPendingPayments()` — núcleo de detección de pagos |

---

## Scripts

### scripts/seed-wallets.ts

Setup inicial del pool de 100 wallets. Leer `README.md` para instrucciones completas.

```bash
# Setup completo
npx ts-node --project tsconfig.json scripts/seed-wallets.ts

# Probar con menos wallets
npx ts-node --project tsconfig.json scripts/seed-wallets.ts --count 5
```

Lee las variables de entorno de `.env.local`. Si el pool ya tiene wallets, el script continúa agregando desde el siguiente índice disponible — no pisa las existentes.
