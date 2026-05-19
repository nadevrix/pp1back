// ─── Onboarding ─────────────────────────────────────────────────────────────
// POST /api/merchant/onboarding — marca profiles.onboarding_completed = true.
//
// Lo llama /onboarding/plan en el front después de que el merchant elige plan.
// Si eligió Free/Starter/Growth, el tier ya se asignó vía billing/upgrade y
// solo queda flaggear esto. Si eligió Scale, billing/status también marca el
// flag al activar — este endpoint sirve como fallback explícito.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';

export async function POST(request: Request) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const { error } = await supabase
            .from('profiles')
            .update({ onboarding_completed: true })
            .eq('id', user.id);
        if (error) throw error;
        return NextResponse.json({ success: true });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Onboarding mark error:', msg);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
