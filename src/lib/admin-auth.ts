import { NextResponse } from 'next/server';

const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || '';

export const SUPPORT_CONTACT = {
    phone: process.env.SUPPORT_PHONE || '',
    message: process.env.SUPPORT_MESSAGE || 'Contact Pollar Pay support for refund assistance.'
};

/**
 * Validates the X-Admin-Secret header against the env var ADMIN_SECRET_KEY.
 * Returns null if valid, or a NextResponse error if invalid.
 */
export function validateAdminAuth(request: Request): NextResponse | null {
    if (!ADMIN_SECRET) {
        console.error('[AUTH] ADMIN_SECRET_KEY is not set in environment variables!');
        return NextResponse.json(
            { error: 'Server misconfiguration: Admin auth not configured' },
            { status: 500 }
        );
    }

    const providedSecret = request.headers.get('X-Admin-Secret');

    if (!providedSecret || providedSecret !== ADMIN_SECRET) {
        return NextResponse.json(
            { error: 'Unauthorized: Invalid or missing admin credentials' },
            { status: 401 }
        );
    }

    return null; // Auth passed
}
