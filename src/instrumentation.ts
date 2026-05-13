// ─── Next.js instrumentation ────────────────────────────────────────────────
// Se ejecuta UNA vez al arrancar el server (no en cada request).
// Acá levantamos el worker de pagos que mantiene los SSE de Horizon vivos.
//
// Apagar con WORKER_ENABLED=false (útil en build, en CI, o si querés correr
// el worker como proceso separado).
// ─────────────────────────────────────────────────────────────────────────────

export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return;
    if (process.env.WORKER_ENABLED === 'false') return;

    const { startWorker } = await import('@/worker');
    startWorker();
}
