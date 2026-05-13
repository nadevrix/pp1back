// ─── CORS middleware ────────────────────────────────────────────────────────
// pollar-web (otro origen) llama a pollar-backend con `Authorization: Bearer`.
// Necesitamos permitir el preflight OPTIONS y los headers correctos.
//
// CORS_ALLOWED_ORIGINS: lista de orígenes separados por coma.
//   Ej: "http://localhost:3002,https://pay.tudominio.com"
// Si está vacío, permite "*" (solo recomendado para dev).
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse, type NextRequest } from 'next/server';

const RAW_ORIGINS = process.env.CORS_ALLOWED_ORIGINS || '';
const ALLOWED_ORIGINS = RAW_ORIGINS
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

function resolveOrigin(req: NextRequest): string {
    const origin = req.headers.get('origin') || '';
    if (ALLOWED_ORIGINS.length === 0) return '*';
    if (ALLOWED_ORIGINS.includes(origin)) return origin;
    return ALLOWED_ORIGINS[0];
}

export function middleware(req: NextRequest) {
    if (!req.nextUrl.pathname.startsWith('/api/')) {
        return NextResponse.next();
    }

    const origin = resolveOrigin(req);

    if (req.method === 'OPTIONS') {
        return new NextResponse(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': origin,
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-pollar-api-key, x-admin-secret, x-cron-secret',
                'Access-Control-Max-Age': '86400',
                'Vary': 'Origin',
            },
        });
    }

    const res = NextResponse.next();
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Vary', 'Origin');
    return res;
}

export const config = {
    matcher: ['/api/:path*'],
};
