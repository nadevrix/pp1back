import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: Request) {
    try {
        const { merchant_id, name, reason, payout_wallet } = await request.json();

        if (!merchant_id || !name || !reason) {
            return NextResponse.json(
                { error: 'Missing required fields: merchant_id, name, reason' },
                { status: 400 }
            );
        }

        // Check if merchant profile exists
        const { data: profile, error: pError } = await supabase
            .from('profiles')
            .select('id')
            .eq('id', merchant_id)
            .single();

        if (pError || !profile) {
            // For dev/test, auto-create a profile if it doesn't exist
            await supabase.from('profiles').insert({ id: merchant_id });
        }

        // Insert the new project into Supabase database
        const { data, error } = await supabase
            .from('projects')
            .insert({
                merchant_id,
                name,
                reason,
                payout_wallet: payout_wallet || null
            })
            .select('id, api_key, name')
            .single();

        if (error) throw error;

        return NextResponse.json({
            success: true,
            message: 'Project created successfully',
            project: data
        }, { status: 201 });

    } catch (err: any) {
        console.error("Project Creation Error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
